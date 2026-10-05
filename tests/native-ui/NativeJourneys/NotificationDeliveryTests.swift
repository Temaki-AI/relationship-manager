import XCTest

/// Run only in an isolated simulator. No Google account or owner data is used.
final class NotificationDeliveryTests: XCTestCase {
    private let journal = XCUIApplication(bundleIdentifier: "com.fernandoamaral.bonds")

    private func tap(_ label: String) {
        let button = journal.buttons[label].firstMatch
        XCTAssertTrue(button.waitForExistence(timeout: 15))
        for _ in 0..<8 {
            if button.isHittable { break }
            journal.scrollViews.allElementsBoundByIndex.last(where: { $0.isHittable && $0.frame.height > 200 })?.swipeUp()
        }
        XCTAssertTrue(button.isHittable)
        button.tap()
    }

    func testPrepareNotificationFixture() {
        continueAfterFailure = false
        journal.launch()
        if journal.buttons["Use only on this iPhone"].waitForExistence(timeout: 5) {
            tap("Use only on this iPhone")
            tap("People")
            tap("Add someone")
            let name = journal.textFields["Name"]
            XCTAssertTrue(name.waitForExistence(timeout: 15))
            name.tap()
            for character in "Everclose Native QA" { name.typeText(String(character)) }
            XCTAssertEqual(name.value as? String, "Everclose Native QA")
            tap("Add to Everclose")
            XCTAssertTrue(journal.staticTexts["Everclose Native QA"].waitForExistence(timeout: 15))
        }
        tap("Reminders")
        tap("Create reminder")
        let title = journal.textFields["Reminder title"]
        XCTAssertTrue(title.waitForExistence(timeout: 15))
        title.tap()
        for character in "Delivery QA" { title.typeText(String(character)) }
        XCTAssertEqual(title.value as? String, "Delivery QA")
        tap("Save reminder")
        let system = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = system.alerts.buttons["Allow"].firstMatch
        XCTAssertTrue(allow.waitForExistence(timeout: 15), "Notification permission was never requested")
        allow.tap()
        XCTAssertTrue(journal.staticTexts["Delivery QA"].waitForExistence(timeout: 15))
        XCTAssertFalse(journal.alerts["Reminder saved without an alert"].exists)
        let screenshot = XCTAttachment(screenshot: journal.screenshot())
        screenshot.name = "Reminder after explicit simulator notification permission"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    /// The host fixture driver sets a near-future time, verifies its persisted
    /// iOS scheduling receipt, then terminates Everclose before this test.
    func testObserveClosedAppDelivery() {
        continueAfterFailure = false
        XCUIDevice.shared.press(.home)
        XCTAssertNotEqual(journal.state, .runningForeground)
        let system = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let notification = system.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "Everclose reminder")).firstMatch
        XCTAssertTrue(notification.waitForExistence(timeout: 60), "The scheduled reminder did not appear with Everclose closed")
        XCTAssertNotEqual(journal.state, .runningForeground)
        let screenshot = XCTAttachment(screenshot: system.screenshot())
        screenshot.name = "Everclose local notification with the app closed"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }
}
