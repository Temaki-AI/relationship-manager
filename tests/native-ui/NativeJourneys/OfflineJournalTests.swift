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
        let scroll = journal.scrollViews.allElementsBoundByIndex.last(where: { $0.isHittable })
        XCTAssertNotNil(scroll, "No foreground scroll view")
        scroll?.swipeUp()
    }

    private func tap(_ label: String) {
        let button = journal.buttons[label].firstMatch
        XCTAssertTrue(button.waitForExistence(timeout: 15), "Missing button: \(label)")
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
        if replace, let old = input.value as? String {
            for _ in old { input.typeText(XCUIKeyboardKey.delete.rawValue) }
        }
        // Public XCTest events wait for each keystroke to settle before the next.
        for character in value { input.typeText(String(character)) }
        let expected = value.hasSuffix("\n") && !multiline ? String(value.dropLast()) : value
        XCTAssertEqual(input.value as? String, appendTo + expected, "Typed text changed in \(label)")
    }

    private func restart() {
        journal.terminate()
        journal.launch()
    }

    private func expectGone(_ element: XCUIElement) {
        let disappeared = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [disappeared], timeout: 15), .completed)
    }

    func testOfflineJournalAndRestart() {
        XCTAssertTrue(journal.buttons["Continue with Google"].waitForExistence(timeout: 20))
        tap("Use only on this iPhone")
        XCTAssertTrue(journal.staticTexts["Your day is clear"].waitForExistence(timeout: 15))

        tap("Agenda")
        XCTAssertTrue(journal.buttons["New plan"].waitForExistence(timeout: 15))
        tap("Reminders")
        XCTAssertTrue(journal.staticTexts["Gentle nudges"].waitForExistence(timeout: 15))
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

        journal.terminate()
        journal.launch()
        tap("People")
        tap("Open \(person)")
        XCTAssertTrue(journal.staticTexts[person].waitForExistence(timeout: 15))
        XCTAssertTrue(journal.staticTexts[note].waitForExistence(timeout: 15))
        XCTAssertTrue(journal.staticTexts["native-qa@example.invalid"].exists)

        tap("Edit contact details")
        let addition = "\nDraft kept after restart."
        enter("notes", addition, multiline: true, appendTo: note)
        tap("Close and keep draft")
        restart()
        tap("People")
        tap("Open \(person)")
        tap("Edit contact details")
        XCTAssertTrue(journal.staticTexts["Resumed your saved draft. Its original version is kept so cloud changes can be reviewed."].exists)
        XCTAssertEqual(input("notes", multiline: true).value as? String, note + addition)
        tap("Save details")
        XCTAssertTrue(journal.staticTexts[note + addition].waitForExistence(timeout: 15))

        restart()
        tap("Agenda")
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
        tap("Agenda")
        XCTAssertTrue(journal.staticTexts["Simulator follow-up"].waitForExistence(timeout: 15))
        tap("Confirm it happened")
        journal.alerts.buttons["It happened"].tap()
        expectGone(journal.staticTexts["Simulator follow-up"])
        tap("People")
        tap("Open \(person)")
        XCTAssertTrue(journal.staticTexts["Simulator follow-up"].waitForExistence(timeout: 15))

        restart()
        tap("Reminders")
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
        XCTAssertTrue(journal.staticTexts["Simulator check-in"].waitForExistence(timeout: 15))
        let time = journal.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "9:00")).firstMatch
        XCTAssertTrue(time.waitForExistence(timeout: 15))
        let initialTime = time.label
        restart()
        tap("Reminders")
        XCTAssertTrue(journal.staticTexts["Simulator check-in"].waitForExistence(timeout: 15))
        tap("Snooze reminder for \(person)")
        journal.alerts.buttons["Next week · 9:00 AM"].tap()
        if journal.alerts["Reminder moved without an alert"].waitForExistence(timeout: 5) {
            journal.alerts.buttons["OK"].tap()
        }
        XCTAssertFalse(journal.staticTexts[initialTime].exists, "The reminder did not move to next week")
        restart()
        tap("Reminders")
        XCTAssertTrue(journal.staticTexts["Simulator check-in"].waitForExistence(timeout: 15))
        XCTAssertFalse(journal.staticTexts[initialTime].exists)
        tap("Complete reminder for \(person)")
        expectGone(journal.staticTexts["Simulator check-in"])
        restart()
        tap("Reminders")
        XCTAssertFalse(journal.staticTexts["Simulator check-in"].exists)

        restart()
        tap("Account and sync")
        XCTAssertTrue(journal.staticTexts["Device lock"].waitForExistence(timeout: 15))
        XCTAssertTrue(journal.buttons["Enable device lock"].exists)
        XCTAssertFalse(journal.buttons["Turn off device lock"].exists)
    }
}
