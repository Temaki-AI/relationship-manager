import XCTest

final class OfflineJournalTests: XCTestCase {
    private let person = "Everclose Native QA"
    private let note = "Synthetic simulator fixture for offline persistence."
    private var journal: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        journal = XCUIApplication(bundleIdentifier: "com.fernandoamaral.bonds")
        journal.launch()
    }

    override func tearDownWithError() throws {
        let screenshot = XCTAttachment(screenshot: journal.screenshot())
        screenshot.name = "Everclose native journey"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        let hierarchy = XCTAttachment(string: journal.debugDescription)
        hierarchy.name = "Everclose accessibility hierarchy"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
    }

    private func scrollUp() {
        let scroll = journal.scrollViews.allElementsBoundByIndex.last(where: { $0.isHittable && $0.frame.height > 200 })
        XCTAssertNotNil(scroll, "No foreground scroll view")
        scroll?.swipeUp()
    }

    private func tap(_ label: String) {
        let button = journal.buttons[label].firstMatch
        XCTAssertTrue(button.waitForExistence(timeout: 15), "Missing button: \(label)")
        // Navigation sits outside the scrolling screen. After a cold launch,
        // its accessibility nodes can appear before UIKit permits interaction.
        // Wait for readiness instead of trying to scroll a navigation button.
        if ["Today", "People", "Calendar", "Settings", "Account and sync"].contains(label) {
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isHittable == true"), object: button)
            XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 20), .completed, "Navigation is not ready: \(label)")
            button.tap()
            return
        }
        for _ in 0..<8 {
            if button.isHittable { break }
            scrollUp()
        }
        XCTAssertTrue(button.isHittable, "Button is not reachable: \(label)")
        button.tap()
    }

    private func input(_ label: String, multiline: Bool = false) -> XCUIElement {
        multiline
            ? journal.textViews.matching(NSPredicate(format: "label BEGINSWITH %@", label)).firstMatch
            : journal.textFields[label]
    }

    private func enter(_ label: String, _ value: String, multiline: Bool = false, appendTo: String = "", replace: Bool = false) {
        let input = multiline
            ? journal.textViews.matching(NSPredicate(format: "label BEGINSWITH %@", label)).firstMatch
            : journal.textFields[label]
        XCTAssertTrue(input.waitForExistence(timeout: 15), "Missing input: \(label)")
        for _ in 0..<8 {
            if input.isHittable { break }
            scrollUp()
        }
        XCTAssertTrue(input.isHittable, "Input is not reachable: \(label)")
        input.tap()
        var lastKeyboardFrame: CGRect?
        let keyboardSettled = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let keyboard = self.journal.keyboards.firstMatch
            guard keyboard.exists, keyboard.frame.height > 100 else { return false }
            let current = keyboard.frame
            defer { lastKeyboardFrame = current }
            return lastKeyboardFrame == current
        }, object: journal)
        XCTAssertEqual(XCTWaiter.wait(for: [keyboardSettled], timeout: 10), .completed, "Keyboard did not settle")
        // Opening the keyboard shrinks the viewport. Keep the focused input
        // visible before using native text-selection controls.
        for _ in 0..<8 {
            // The predictive-text strip can sit above the keyboard's reported
            // frame, so leave room for it as well as the keyboard itself.
            if input.frame.minY >= 0, input.frame.maxY <= journal.keyboards.firstMatch.frame.minY - 60 { break }
            scrollUp()
        }
        if !appendTo.isEmpty {
            // The short synthetic note fits in this field. A native tap below
            // its last line places the caret at the end before appending.
            input.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.85)).tap()
        }
        if replace {
            // These short date fields fit on one line. Tapping the trailing
            // edge puts the caret after the existing value without relying on
            // the OS version's text-selection menu labels.
            let original = input.value as? String ?? ""
            input.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
            input.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: original.count))
            let cleared = input.value as? String
            XCTAssertTrue(cleared == "" || cleared == input.placeholderValue, "Native field was not cleared")
        }
        // Public XCTest events wait for each keystroke to settle before the next.
        for character in value { input.typeText(String(character)) }
        let expected = value.hasSuffix("\n") && !multiline ? String(value.dropLast()) : value
        XCTAssertEqual(input.value as? String, appendTo + expected, "Typed text changed in \(label)")
    }

    private func restart() {
        journal.terminate()
        journal.launch()
        XCTAssertTrue(journal.wait(for: .runningForeground, timeout: 20), "Journal did not return to the foreground")
        // Redirecting after launch replaces the native tab view. Resolve the
        // current element on each poll rather than retaining its first handle.
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let today = self.journal.buttons["Today"].firstMatch
            return today.exists && today.isHittable
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 20), .completed, "Journal navigation did not become interactive after restart")
    }

    private func expectGone(_ element: XCUIElement) {
        let disappeared = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [disappeared], timeout: 15), .completed)
    }

    private func reminderCard(_ title: String) -> XCUIElement {
        journal.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", "Open \(person). Reminder:", title)).firstMatch
    }

    func testOfflineJournalAndRestart() {
        XCTAssertTrue(journal.buttons["Continue with Google"].waitForExistence(timeout: 20))
        tap("Use only on this iPhone")
        XCTAssertTrue(journal.staticTexts["Your day is clear"].waitForExistence(timeout: 15))

        tap("Calendar")
        XCTAssertTrue(journal.buttons["New plan"].waitForExistence(timeout: 15))
        tap("Calendar"); tap("All reminders")
        XCTAssertTrue(journal.staticTexts["Reminders"].waitForExistence(timeout: 15))
        journal.navigationBars.buttons.element(boundBy: 0).tap()
        tap("People")
        tap("Add someone")
        // A prior diagnostic run may have left this test's own unfinished draft.
        if journal.textFields["Name"].value as? String == person {
            tap("Discard draft")
            journal.alerts.buttons["Discard"].tap()
            tap("Add someone")
        }
        enter("Name", person)
        enter("Email", "native-qa@example.invalid\n")
        enter("Notes", note, multiline: true)
        tap("Add to Everclose")
        XCTAssertTrue(journal.staticTexts[person].waitForExistence(timeout: 15))

        restart()
        tap("People")
        tap("Open \(person)")
        XCTAssertTrue(journal.staticTexts[person].waitForExistence(timeout: 15))
        XCTAssertTrue(journal.staticTexts[note].waitForExistence(timeout: 15))
        XCTAssertTrue(journal.staticTexts["native-qa@example.invalid"].exists)

        tap("Details"); tap("Edit contact details")
        let addition = "\nDraft kept after restart."
        XCTAssertEqual(input("notes", multiline: true).value as? String, note)
        enter("notes", addition, multiline: true, appendTo: note)
        tap("Close and keep draft")
        restart()
        tap("People")
        tap("Open \(person)")
        tap("Details"); tap("Edit contact details")
        XCTAssertTrue(journal.staticTexts["Resumed your saved draft. Its original version is kept so cloud changes can be reviewed."].exists)
        XCTAssertEqual(input("notes", multiline: true).value as? String, note + addition)
        tap("Save details"); tap("Overview")
        XCTAssertTrue(journal.staticTexts[note + addition].waitForExistence(timeout: 15))

        restart()
        tap("Calendar")
        tap("New plan")
        let choice = journal.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "\(person), native-qa@example.invalid")).firstMatch
        XCTAssertTrue(choice.waitForExistence(timeout: 15))
        choice.tap()
        let day = DateFormatter()
        day.locale = Locale(identifier: "en_US_POSIX")
        day.dateFormat = "yyyy-MM-dd"
        enter("Planned date", day.string(from: Calendar.current.date(byAdding: .day, value: 3, to: Date())!), replace: true)
        enter("Summary", "Simulator follow-up")
        enter("Notes", "Synthetic agenda fixture.", multiline: true)
        tap("Save")
        XCTAssertTrue(journal.staticTexts["Simulator follow-up"].waitForExistence(timeout: 15))
        restart()
        tap("Calendar")
        XCTAssertTrue(journal.staticTexts["Simulator follow-up"].waitForExistence(timeout: 15))
        tap("Confirm it happened")
        journal.alerts.buttons["It happened"].tap()
        expectGone(journal.staticTexts["Simulator follow-up"])
        tap("People")
        tap("Open \(person)")
        tap("Activity")
        XCTAssertTrue(journal.staticTexts["Simulator follow-up"].waitForExistence(timeout: 15))

        restart()
        tap("Calendar"); tap("All reminders")
        tap("Create reminder")
        enter("Reminder title", "Simulator check-in")
        enter("Reminder notes", "Synthetic reminder fixture.", multiline: true)
        tap("Save reminder")
        let system = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if system.alerts.firstMatch.waitForExistence(timeout: 5) {
            let deny = system.alerts.buttons.matching(NSPredicate(format: "label IN %@", ["Don’t Allow", "Don't Allow"])).firstMatch
            XCTAssertTrue(deny.waitForExistence(timeout: 5))
            deny.tap()
            expectGone(deny)
        }
        if journal.alerts["Reminder saved without an alert"].waitForExistence(timeout: 5) {
            journal.alerts.buttons["OK"].tap()
        }
        XCTAssertTrue(reminderCard("Simulator check-in").waitForExistence(timeout: 15))
        let time = journal.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "9:00")).firstMatch
        XCTAssertTrue(time.waitForExistence(timeout: 15))
        let initialTime = time.label
        restart()
        tap("Calendar"); tap("All reminders")
        XCTAssertTrue(reminderCard("Simulator check-in").waitForExistence(timeout: 15))
        tap("Snooze reminder for \(person): Simulator check-in")
        tap("Next week · 9:00 AM")
        if journal.alerts["Reminder moved without an alert"].waitForExistence(timeout: 5) {
            journal.alerts.buttons["OK"].tap()
        }
        XCTAssertFalse(journal.staticTexts[initialTime].exists, "The reminder did not move to next week")
        restart()
        tap("Calendar"); tap("All reminders")
        XCTAssertTrue(reminderCard("Simulator check-in").waitForExistence(timeout: 15))
        XCTAssertFalse(journal.staticTexts[initialTime].exists)
        tap("Complete reminder for \(person): Simulator check-in")
        expectGone(reminderCard("Simulator check-in"))
        restart()
        tap("Calendar"); tap("All reminders")
        XCTAssertFalse(reminderCard("Simulator check-in").exists)

        restart()
        tap("Settings")
        XCTAssertTrue(journal.staticTexts["Device lock"].waitForExistence(timeout: 15))
        XCTAssertTrue(journal.buttons["Enable device lock"].exists)
        XCTAssertFalse(journal.buttons["Turn off device lock"].exists)
    }
}
