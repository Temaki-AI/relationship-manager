import XCTest

// Serial checks on the retained synthetic QA simulator only. The host retimes
// this test's two reminders between preparation and the action checks.
final class TodayTests: XCTestCase {
    private let person = "Everclose Today QA"
    private let first = "Today first nudge"
    private let second = "Today second nudge"
    private var journal: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        journal = XCUIApplication(bundleIdentifier: "com.fernandoamaral.bonds")
        journal.launch()
    }
    override func tearDownWithError() throws {
        let screenshot = XCTAttachment(screenshot: journal.screenshot())
        screenshot.name = "Everclose Today daily queue"; screenshot.lifetime = .keepAlways; add(screenshot)
        let hierarchy = XCTAttachment(string: journal.debugDescription)
        hierarchy.name = "Today action accessibility hierarchy"; hierarchy.lifetime = .keepAlways; add(hierarchy)
    }
    private func tap(_ label: String) {
        let button = journal.buttons[label].firstMatch
        XCTAssertTrue(button.waitForExistence(timeout: 15), "Missing button: \(label)")
        for _ in 0..<12 {
            if button.isHittable { break }
            journal.scrollViews.allElementsBoundByIndex.last(where: { $0.isHittable && $0.frame.height > 200 })?.swipeUp()
        }
        XCTAssertTrue(button.isHittable, "Unreachable button: \(label)"); button.tap()
    }
    private func enter(_ label: String, _ value: String) {
        let field = journal.textFields[label]
        XCTAssertTrue(field.waitForExistence(timeout: 15)); field.tap()
        for character in value { field.typeText(String(character)) }
        XCTAssertEqual(field.value as? String, value.hasSuffix("\n") ? String(value.dropLast()) : value)
    }
    private func restart() { journal.terminate(); journal.launch(); tap("Today") }
    private func expectGone(_ element: XCUIElement) {
        let disappeared = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [disappeared], timeout: 15), .completed)
    }
    private func dismissAlertWarning() {
        let warning = journal.alerts["Reminder moved without an alert"]
        if warning.waitForExistence(timeout: 3) { warning.buttons["OK"].tap() }
    }
    private func saveReminder(_ title: String) {
        tap("Set reminder"); enter("Reminder title", title); tap("Save reminder")
        if journal.alerts["Reminder saved without an alert"].waitForExistence(timeout: 3) {
            journal.alerts.buttons["OK"].tap()
        }
        XCTAssertTrue(journal.staticTexts[title].waitForExistence(timeout: 15))
    }

    func testPrepareTodayFixture() {
        if journal.buttons["Use only on this iPhone"].waitForExistence(timeout: 2) { tap("Use only on this iPhone") }
        tap("People"); tap("Add someone")
        enter("Name", person); enter("Email", "today-qa@example.invalid\n")
        tap("Add to Everclose")
        XCTAssertTrue(journal.staticTexts[person].waitForExistence(timeout: 15))
        saveReminder(first)
        restart(); tap("People"); tap("Open \(person)")
        saveReminder(second)
    }

    func testDailyQueueCancelActionsDoNotRecordHistory() {
        tap("Today")
        let profile = journal.buttons["Open \(person) from Today"]
        XCTAssertTrue(profile.waitForExistence(timeout: 15))
        XCTAssertEqual(journal.buttons.matching(NSPredicate(format: "label == %@", "Open \(person) from Today")).count, 1)
        XCTAssertTrue(journal.staticTexts["Birthday today for \(person)"].exists)
        XCTAssertTrue(journal.staticTexts["Time for a check-in for \(person)"].exists)
        XCTAssertTrue(journal.buttons["Complete reminder for \(person): \(first)"].exists)
        tap("Reach out to \(person)")
        XCTAssertTrue(journal.alerts["Reach out to \(person)"].waitForExistence(timeout: 5))
        XCTAssertTrue(journal.alerts.staticTexts["Opening another app does not record a conversation."].exists)
        journal.alerts.buttons["Cancel"].tap()
        tap("Log conversation with \(person)")
        XCTAssertTrue(journal.alerts["Record a conversation"].waitForExistence(timeout: 5))
        journal.alerts.buttons["Cancel"].tap()
        restart()
        XCTAssertTrue(journal.buttons["Complete reminder for \(person): \(first)"].waitForExistence(timeout: 15))
        XCTAssertTrue(journal.staticTexts["Time for a check-in for \(person)"].exists)
    }

    func testDailyQueueSnoozeCompleteAndExplicitLogSurviveRestart() {
        tap("Today")
        tap("Snooze reminder for \(person): \(first)")
        journal.alerts.buttons["Tomorrow · 9:00 AM"].tap(); dismissAlertWarning()
        XCTAssertTrue(journal.buttons["Complete reminder for \(person): \(second)"].waitForExistence(timeout: 15))
        restart()
        XCTAssertTrue(journal.buttons["Complete reminder for \(person): \(second)"].waitForExistence(timeout: 15))
        tap("Complete reminder for \(person): \(second)")
        expectGone(journal.buttons["Complete reminder for \(person): \(second)"])
        XCTAssertTrue(journal.staticTexts["Birthday today for \(person)"].exists)
        XCTAssertTrue(journal.staticTexts["Time for a check-in for \(person)"].exists)
        tap("Log conversation with \(person)"); journal.alerts.buttons["Messaged"].tap()
        expectGone(journal.staticTexts["Time for a check-in for \(person)"])
        XCTAssertTrue(journal.staticTexts["Conversation with \(person) recorded."].exists)
        restart()
        XCTAssertTrue(journal.staticTexts["Birthday today for \(person)"].waitForExistence(timeout: 15))
        XCTAssertFalse(journal.staticTexts["Time for a check-in for \(person)"].exists)
        XCTAssertFalse(journal.buttons["Complete reminder for \(person): \(second)"].exists)
        tap("Open \(person) from Today")
        XCTAssertTrue(journal.staticTexts["today-qa@example.invalid"].waitForExistence(timeout: 15))
        XCTAssertTrue(journal.staticTexts["Logged a message"].exists)
    }
}
