import SwiftUI
import Contacts

// XCTest's small host does not replace or compile the Everclose application.
@main
struct NativeTestHost: App {
    var body: some Scene {
        WindowGroup { SyntheticContactsFixture() }
    }
}

// The opt-in fixture uses the simulator's real Contacts framework. It is never
// compiled into Everclose and refuses to write on a physical device.
private struct SyntheticContactsFixture: View {
    @State private var status = "Everclose native test host"

    var body: some View {
        Text(status).padding().task {
            let verifyOnly = ProcessInfo.processInfo.arguments.contains("--verify-contacts-fixture")
            guard verifyOnly || ProcessInfo.processInfo.arguments.contains("--contacts-fixture"),
                  ProcessInfo.processInfo.environment["EVERCLOSE_SYNTHETIC_CONTACTS_QA"] == "1" else { return }
            #if targetEnvironment(simulator)
            do {
                try await seedContacts(verifyOnly: verifyOnly)
                status = verifyOnly ? "Synthetic Contacts unchanged" : "Synthetic Contacts ready"
            } catch {
                status = "Synthetic Contacts fixture failed"
            }
            #else
            status = "Contacts fixture requires a dedicated simulator"
            #endif
        }
    }

    #if targetEnvironment(simulator)
    private enum FixtureError: Error { case permission, ambiguous, changed }

    private func seedContacts(verifyOnly: Bool) async throws {
        let store = CNContactStore()
        if CNContactStore.authorizationStatus(for: .contacts) == .notDetermined {
            guard !verifyOnly else { throw FixtureError.permission }
            guard try await store.requestAccess(for: .contacts) else { throw FixtureError.permission }
        }
        guard CNContactStore.authorizationStatus(for: .contacts) == .authorized else { throw FixtureError.permission }
        var ids: [String: String] = [:]
        for (family, email, phone) in [
            ("Source QA", "source-qa@example.invalid", "+1 202-555-0125"),
            ("New Source QA", "create-qa@example.invalid", "+1 202-555-0126")
        ] {
            let existing = try store.unifiedContacts(matching: CNContact.predicateForContacts(matchingEmailAddress: email),
                keysToFetch: [CNContactGivenNameKey, CNContactFamilyNameKey, CNContactEmailAddressesKey, CNContactPhoneNumbersKey] as [CNKeyDescriptor])
            guard existing.count <= 1 else { throw FixtureError.ambiguous }
            if let contact = existing.first {
                guard contact.givenName == "Everclose", contact.familyName == family,
                      contact.emailAddresses.count == 1, contact.emailAddresses[0].value as String == email,
                      contact.emailAddresses[0].label == CNLabelWork,
                      contact.phoneNumbers.count == 1, contact.phoneNumbers[0].value.stringValue == phone,
                      contact.phoneNumbers[0].label == CNLabelPhoneNumberMobile else { throw FixtureError.changed }
                ids[email] = contact.identifier
                continue
            }
            guard !verifyOnly else { throw FixtureError.changed }
            let contact = CNMutableContact()
            contact.givenName = "Everclose"; contact.familyName = family
            contact.emailAddresses = [CNLabeledValue(label: CNLabelWork, value: email as NSString)]
            contact.phoneNumbers = [CNLabeledValue(label: CNLabelPhoneNumberMobile, value: CNPhoneNumber(stringValue: phone))]
            let request = CNSaveRequest(); request.add(contact, toContainerWithIdentifier: nil)
            try store.execute(request)
            ids[email] = contact.identifier
        }
        if !verifyOnly {
            let receipt = try JSONSerialization.data(withJSONObject: ["syntheticOnly": true, "ids": ids], options: [.sortedKeys])
            try receipt.write(to: URL.documentsDirectory.appendingPathComponent("contacts-fixture.json"), options: .atomic)
        }
    }
    #endif
}
