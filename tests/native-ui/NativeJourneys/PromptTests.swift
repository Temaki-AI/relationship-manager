import XCTest

// Run only on the retained, local-only synthetic QA simulator. No provider
// consent or real-account sign-in is part of these preference checks.
final class PromptTests: XCTestCase {
    private let birthdayPerson = "Everclose Today Accessible QA"
    private let checkInPerson = "Everclose Private QA"
    private var journal: XCUIApplication!
    private var birthdayReason: XCUIElement {
        journal.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@ AND label ENDSWITH %@", "Birthday", "for \(birthdayPerson)")).firstMatch
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        journal = XCUIApplication(bundleIdentifier: "com.fernandoamaral.bonds")
        journal.launch(); tap("Today")
    }
    override func tearDownWithError() throws {
        let screenshot = XCTAttachment(screenshot: journal.screenshot())
        screenshot.name = "Today prompt preferences"; screenshot.lifetime = .keepAlways; add(screenshot)
        let hierarchy = XCTAttachment(string: journal.debugDescription)
        hierarchy.name = "Prompt preference accessibility"; hierarchy.lifetime = .keepAlways; add(hierarchy)
    }
    private func scrollTo(_ element: XCUIElement) {
        for _ in 0..<12 {
            if element.isHittable { return }
            journal.scrollViews.allElementsBoundByIndex.last(where: { $0.isHittable && $0.frame.height > 200 })?.swipeUp()
        }
    }
    private func tap(_ label: String) {
        let button = journal.buttons[label].firstMatch
        XCTAssertTrue(button.waitForExistence(timeout: 15), "Missing button: \(label)")
        scrollTo(button); XCTAssertTrue(button.isHittable, "Unreachable button: \(label)"); button.tap()
    }
    private func gone(_ element: XCUIElement) {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 15), .completed)
    }
    private func restart() { journal.terminate(); journal.launch(); tap("Today") }
    private func expandSnoozes() {
        let button = journal.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Snoozed prompts,")).firstMatch
        XCTAssertTrue(button.waitForExistence(timeout: 15)); scrollTo(button); XCTAssertTrue(button.isHittable); button.tap()
    }

    func testPromptChoicesSurviveRestartAndBringBackOnlyTheirReason() {
        tap("Snooze birthday prompt for \(birthdayPerson)")
        XCTAssertTrue(journal.staticTexts["Snooze birthday prompt"].waitForExistence(timeout: 5))
        tap("Cancel")
        XCTAssertTrue(birthdayReason.exists)
        tap("Snooze birthday prompt for \(birthdayPerson)"); tap("In a week")
        gone(birthdayReason)
        tap("Snooze check-in prompt for \(checkInPerson)"); tap("Tomorrow")
        gone(journal.staticTexts["Time for a check-in for \(checkInPerson)"])
        restart()
        XCTAssertFalse(birthdayReason.exists)
        XCTAssertFalse(journal.staticTexts["Time for a check-in for \(checkInPerson)"].exists)
        expandSnoozes()
        tap("Bring back birthday prompt for \(birthdayPerson)")
        XCTAssertTrue(birthdayReason.waitForExistence(timeout: 15))
        XCTAssertFalse(journal.staticTexts["Time for a check-in for \(checkInPerson)"].exists)
        tap("Bring back check-in prompt for \(checkInPerson)")
        restart()
        XCTAssertTrue(birthdayReason.waitForExistence(timeout: 15))
        XCTAssertTrue(journal.staticTexts["Time for a check-in for \(checkInPerson)"].exists)
        XCTAssertFalse(journal.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Snoozed prompts,")).firstMatch.exists)
    }

    // Invoke separately with the largest accessibility text size.
    func testLargestTextPromptPickerKeepsCancelAndChoicesReachable() {
        tap("Snooze birthday prompt for \(birthdayPerson)")
        let cancel = journal.buttons["Cancel"].firstMatch
        XCTAssertTrue(cancel.isHittable); XCTAssertGreaterThanOrEqual(cancel.frame.height, 44)
        for label in ["Tomorrow", "In a week", "In 30 days"] {
            let choice = journal.buttons[label].firstMatch
            XCTAssertTrue(choice.exists); scrollTo(choice); XCTAssertTrue(choice.isHittable)
            XCTAssertGreaterThanOrEqual(choice.frame.height, 44)
        }
        let screenshot = XCTAttachment(screenshot: journal.screenshot())
        screenshot.name = "Largest text prompt picker with persistent Cancel"
        screenshot.lifetime = .keepAlways; add(screenshot)
        XCTAssertTrue(cancel.isHittable); cancel.tap()
        XCTAssertTrue(birthdayReason.exists)
    }
}
