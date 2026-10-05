import XCTest

// Serial checks on the retained synthetic QA simulator only. The host retimes
// this test's two reminders between preparation and the action checks.
final class TodayTests: XCTestCase {
    private let person = "Everclose Today Accessible QA"
    private let first = "Today first nudge"
    private let second = "Today second nudge"
    private var journal: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        journal = XCUIApplication(bundleIdentifier: "com.fernandoamaral.bonds")
        journal.launch()
        denyNotificationPromptIfShown()
        if journal.alerts["Reminder saved without an alert"].waitForExistence(timeout: 2) {
            journal.alerts.buttons["OK"].tap()
        }
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
    private func denyNotificationPromptIfShown() {
        let system = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let prompt = system.alerts.firstMatch
        if prompt.waitForExistence(timeout: 3) && prompt.label.contains("Everclose") {
            let deny = prompt.buttons.matching(NSPredicate(format: "label IN %@", ["Don’t Allow", "Don't Allow"])).firstMatch
            XCTAssertTrue(deny.waitForExistence(timeout: 5)); deny.tap(); expectGone(deny)
        }
    }
    private func saveReminder(_ title: String) {
        tap("Set a reminder for \(person)"); enter("Reminder title", title); tap("Save reminder")
        denyNotificationPromptIfShown()
        if journal.alerts["Reminder saved without an alert"].waitForExistence(timeout: 3) {
            journal.alerts.buttons["OK"].tap()
        }
        let card = journal.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", "Open \(person). Reminder:", title)).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 15))
    }

    func testPrepareTodayFixture() {
        if journal.buttons["Use only on this iPhone"].waitForExistence(timeout: 2) { tap("Use only on this iPhone") }
        tap("People")
        if journal.buttons["Open \(person)"].exists { tap("Open \(person)") }
        else {
            tap("Add someone"); enter("Name", person); enter("Email", "today-qa@example.invalid\n")
            tap("Add to Everclose")
        }
        XCTAssertTrue(journal.staticTexts[person].waitForExistence(timeout: 15))
        if !journal.staticTexts[first].exists { saveReminder(first) }
        restart(); tap("People"); tap("Open \(person)")
        if !journal.staticTexts[second].exists { saveReminder(second) }
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
        XCTAssertTrue(journal.staticTexts["Reach out to \(person)"].waitForExistence(timeout: 5))
        XCTAssertTrue(journal.staticTexts["Opening another app does not record a conversation."].exists)
        tap("Cancel")
        tap("Log conversation with \(person)")
        XCTAssertTrue(journal.staticTexts["Record a conversation"].waitForExistence(timeout: 5))
        tap("Cancel")
        restart()
        XCTAssertTrue(journal.buttons["Complete reminder for \(person): \(first)"].waitForExistence(timeout: 15))
        XCTAssertTrue(journal.staticTexts["Time for a check-in for \(person)"].exists)
    }

    func testDailyQueueSnoozeCompleteAndExplicitLogSurviveRestart() {
        tap("Today")
        tap("Snooze reminder for \(person): \(first)")
        tap("Tomorrow · 9:00 AM"); dismissAlertWarning()
        XCTAssertTrue(journal.buttons["Complete reminder for \(person): \(second)"].waitForExistence(timeout: 15))
        restart()
        XCTAssertTrue(journal.buttons["Complete reminder for \(person): \(second)"].waitForExistence(timeout: 15))
        tap("Complete reminder for \(person): \(second)")
        expectGone(journal.buttons["Complete reminder for \(person): \(second)"])
        XCTAssertTrue(journal.staticTexts["Birthday today for \(person)"].exists)
        XCTAssertTrue(journal.staticTexts["Time for a check-in for \(person)"].exists)
        tap("Log conversation with \(person)"); tap("Messaged")
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

    // Invoke separately with simctl content_size accessibility-extra-extra-extra-large.
    func testDailyQueueLargerTextKeepsActionsReachable() {
        tap("Today")
        tap("Reach out to \(person)")
        XCTAssertTrue(journal.staticTexts["Reach out to \(person)"].waitForExistence(timeout: 5))
        tap("Cancel")
        for label in ["Reach out to \(person)", "Log conversation with \(person)", "Open \(person) from Today"] {
            let button = journal.buttons[label].firstMatch
            XCTAssertTrue(button.exists)
            XCTAssertGreaterThanOrEqual(button.frame.height, 44, "Short touch target at larger text: \(label)")
        }
        tap("Log conversation with \(person)")
        XCTAssertTrue(journal.staticTexts["Record a conversation"].waitForExistence(timeout: 5))
        tap("Cancel")
        XCTAssertTrue(journal.staticTexts["Birthday today for \(person)"].exists)
    }

    func testChoicePickerClosesWhenJournalIsBackgrounded() {
        tap("Today"); tap("Reach out to \(person)")
        XCTAssertTrue(journal.staticTexts["Reach out to \(person)"].waitForExistence(timeout: 5))
        XCUIApplication(bundleIdentifier: "com.apple.springboard").activate()
        journal.activate()
        XCTAssertTrue(journal.buttons["Open \(person) from Today"].waitForExistence(timeout: 15))
        XCTAssertFalse(journal.staticTexts["Reach out to \(person)"].exists, "A private choice sheet survived the background cover")
        tap("Reach out to \(person)")
        XCTAssertTrue(journal.staticTexts["Reach out to \(person)"].waitForExistence(timeout: 5)); tap("Cancel")
    }
}
