import XCTest

// Run only on the dedicated synthetic QA simulator. The fixture host writes two
// known Contacts records; Everclose itself must read/import through its actual UI.
final class DeviceContactsTests: XCTestCase {
    private let person = "Everclose Private QA"
    private let note = "Private QA notes stay in Everclose."
    private let preferredEmail = "private-qa@example.invalid"
    private var journal: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        journal = XCUIApplication(bundleIdentifier: "com.fernandoamaral.bonds")
    }

    override func tearDownWithError() throws {
        let screenshot = XCTAttachment(screenshot: journal.screenshot())
        screenshot.name = "Everclose real Contacts integration"
        screenshot.lifetime = .keepAlways; add(screenshot)
        let hierarchy = XCTAttachment(string: journal.debugDescription)
        hierarchy.name = "Contacts journey accessibility hierarchy"
        hierarchy.lifetime = .keepAlways; add(hierarchy)
    }

    private func tap(_ label: String, prefix: Bool = false) {
        let button = prefix
            ? journal.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", label)).firstMatch
            : journal.buttons[label].firstMatch
        XCTAssertTrue(button.waitForExistence(timeout: 15), "Missing button: \(label)")
        for _ in 0..<12 {
            if button.isHittable { break }
            let scroll = journal.scrollViews.allElementsBoundByIndex.last(where: { $0.isHittable && $0.frame.height > 200 })
            XCTAssertNotNil(scroll); scroll?.swipeUp()
        }
        XCTAssertTrue(button.isHittable, "Unreachable button: \(label)")
        button.tap()
    }

    private func enter(_ label: String, _ value: String, multiline: Bool = false) {
        let field = multiline ? journal.textViews.matching(NSPredicate(format: "label BEGINSWITH %@", label)).firstMatch : journal.textFields[label]
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        for _ in 0..<8 {
            if field.isHittable { break }
            journal.scrollViews.allElementsBoundByIndex.last(where: { $0.isHittable && $0.frame.height > 200 })?.swipeUp()
        }
        XCTAssertTrue(field.isHittable); field.tap()
        for character in value { field.typeText(String(character)) }
        XCTAssertEqual(field.value as? String, value.hasSuffix("\n") && !multiline ? String(value.dropLast()) : value)
    }

    private func chooseSource(_ name: String, firstPermission: Bool = false) {
        if firstPermission {
            let system = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            let prompt = system.alerts.firstMatch
            XCTAssertTrue(prompt.waitForExistence(timeout: 10), "Missing real Contacts permission prompt")
            let full = system.buttons["Allow Full Access"].firstMatch
            if !full.exists {
                let next = system.buttons["Continue"].firstMatch
                XCTAssertTrue(next.waitForExistence(timeout: 5)); next.tap()
            }
            // iOS 26 labels this control "Share All <count> Contacts".
            let fullAccess = NSPredicate(format: "label == %@ OR label BEGINSWITH %@", "Allow Full Access", "Share All ")
            let allow = system.buttons.matching(fullAccess).firstMatch
            let appAllow = journal.buttons.matching(fullAccess).firstMatch
            let visible = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in allow.exists || appAllow.exists }, object: nil)
            let found = XCTWaiter.wait(for: [visible], timeout: 10)
            if found != .completed {
                print("Contacts permission system hierarchy: \(system.debugDescription)")
                print("Contacts permission app hierarchy: \(journal.debugDescription)")
            }
            XCTAssertEqual(found, .completed)
            (allow.exists ? allow : appAllow).tap()
        }
        let source = journal.staticTexts[name].firstMatch
        XCTAssertTrue(source.waitForExistence(timeout: 15), "Missing system Contacts fixture: \(name)")
        source.tap()
        XCTAssertTrue(journal.staticTexts["Choose how to save this person"].waitForExistence(timeout: 15))
    }

    private func selectField(_ value: String) {
        let choice = journal.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", value)).firstMatch
        XCTAssertTrue(choice.waitForExistence(timeout: 15))
        for _ in 0..<12 {
            if choice.isHittable { break }
            journal.scrollViews.allElementsBoundByIndex.last(where: { $0.isHittable && $0.frame.height > 200 })?.swipeUp()
        }
        XCTAssertTrue(choice.isHittable); choice.tap()
    }

    private func restart() { journal.terminate(); journal.launch(); tap("People") }

    // Run against the retained two-person fixture with the contact-label update.
    func testSavedContactLabelsAreReadableWithoutRewritingOriginals() {
        journal.launch(); tap("People"); tap("Open \(person)")
        let method = journal.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Open Work: source-qa@example.invalid")).firstMatch
        XCTAssertTrue(method.waitForExistence(timeout: 15), "The saved method must announce a readable Work label")
        XCTAssertFalse(journal.debugDescription.contains("_$!<WORK>!$_"))
        tap("Contact methods")
        let labels = journal.textFields.matching(NSPredicate(format: "label == %@", "email label")).allElementsBoundByIndex
        XCTAssertTrue(labels.contains(where: { $0.value as? String == "Work" }), "The editor must display the readable label")
        XCTAssertFalse(journal.buttons["Save methods"].isEnabled, "Displaying a label must not create an unsaved edit")
        tap("Cancel")
        restart(); tap("Open \(person)")
        XCTAssertTrue(method.waitForExistence(timeout: 15))
        XCTAssertTrue(journal.staticTexts[preferredEmail].exists)
        XCTAssertTrue(journal.staticTexts[note].exists)
    }

    func testReviewedCreateAttachRestartAndUnlink() {
        let host = XCUIApplication(bundleIdentifier: "com.everclose.qa.TestHost")
        host.launchArguments = ["--contacts-fixture"]
        host.launchEnvironment = ["EVERCLOSE_SYNTHETIC_CONTACTS_QA": "1"]
        host.launch()
        XCTAssertTrue(host.staticTexts["Synthetic Contacts ready"].waitForExistence(timeout: 20))
        host.terminate()
        journal.launch()
        if journal.buttons["Use only on this iPhone"].waitForExistence(timeout: 3) { tap("Use only on this iPhone") }
        tap("People"); tap("Add someone")
        enter("Name", person)
        enter("Email", preferredEmail + "\n")
        enter("Notes", note, multiline: true)
        tap("Add to Everclose")
        XCTAssertTrue(journal.staticTexts[person].waitForExistence(timeout: 15))
        tap("Link or review iPhone contact")
        chooseSource("Everclose Source QA", firstPermission: true)
        XCTAssertTrue(journal.staticTexts["Attach to \(person)"].exists)
        selectField("source-qa@example.invalid")
        selectField("+1 202-555-0125")
        tap("Attach source and selected fields")
        XCTAssertTrue(journal.staticTexts[person].waitForExistence(timeout: 15))
        restart(); tap("Open \(person)")
        XCTAssertTrue(journal.staticTexts[preferredEmail].exists, "Attaching replaced the preferred email")
        XCTAssertTrue(journal.staticTexts[note].exists, "Attaching changed private notes")
        XCTAssertTrue(journal.staticTexts["Everclose Source QA"].exists)

        // Importing a source before creating its CRM person uses the same review.
        restart(); tap("Choose from iPhone Contacts", prefix: true)
        chooseSource("Everclose New Source QA")
        XCTAssertEqual(journal.textFields["New person’s name"].value as? String, "Everclose New Source QA")
        selectField("create-qa@example.invalid")
        // The source phone is intentionally not selected.
        tap("Create person and save source")
        XCTAssertTrue(journal.staticTexts["Everclose New Source QA"].waitForExistence(timeout: 15))
        restart(); tap("Open Everclose New Source QA")
        XCTAssertTrue(journal.staticTexts["create-qa@example.invalid"].exists)

        restart(); tap("Open \(person)")
        tap("Unlink iPhone source")
        journal.alerts.buttons["Unlink"].tap()
        let sourceContext = journal.staticTexts["Everclose Source QA"].firstMatch
        let removed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: sourceContext)
        let unlinkFinished = XCTWaiter.wait(for: [removed], timeout: 15)
        if unlinkFinished != .completed { print("Unlink result hierarchy: \(journal.debugDescription)") }
        XCTAssertEqual(unlinkFinished, .completed, "Wait for confirmed unlink before restarting")
        restart(); tap("Open \(person)")
        XCTAssertTrue(journal.staticTexts[preferredEmail].exists)
        XCTAssertTrue(journal.staticTexts[note].exists)
        XCTAssertFalse(journal.staticTexts["Everclose Source QA"].exists, "Unlink did not remove saved source context")
    }

    // Invoke separately after revoking Contacts access on this synthetic device.
    func testDeniedContactsKeepsSavedRelationship() {
        let host = XCUIApplication(bundleIdentifier: "com.everclose.qa.TestHost")
        host.launchArguments = ["--verify-contacts-fixture"]
        host.launchEnvironment = ["EVERCLOSE_SYNTHETIC_CONTACTS_QA": "1"]
        host.launch()
        XCTAssertTrue(host.staticTexts["Synthetic Contacts unchanged"].waitForExistence(timeout: 20), "Everclose modified or removed the system Contacts fixtures")
        host.terminate()
        journal.launch(); tap("People"); tap("Open \(person)")
        tap("Link or review iPhone contact")
        let denial = journal.staticTexts["Contacts access is off. Allow access in iPhone Settings, or add this person manually."]
        XCTAssertTrue(denial.waitForExistence(timeout: 15))
        restart(); tap("Open \(person)")
        XCTAssertTrue(journal.staticTexts[preferredEmail].exists)
        XCTAssertTrue(journal.staticTexts[note].exists)
    }
}
