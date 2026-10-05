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

    private func enter(_ label: String, _ value: String, multiline: Bool = false) {
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
        // Public XCTest events wait for each keystroke to settle before the next.
        for character in value { input.typeText(String(character)) }
        let expected = value.hasSuffix("\n") && !multiline ? String(value.dropLast()) : value
        XCTAssertEqual(input.value as? String, expected, "Typed text changed in \(label)")
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

        journal.terminate()
        journal.launch()
        tap("Account and sync")
        XCTAssertTrue(journal.staticTexts["Device lock"].waitForExistence(timeout: 15))
        XCTAssertTrue(journal.buttons["Enable device lock"].exists)
        XCTAssertFalse(journal.buttons["Turn off device lock"].exists)
    }
}
