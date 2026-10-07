import XCTest

// Run after OfflineJournalTests on the same disposable simulator. Only the
// known synthetic contact is used; no account or external app is opened.
final class UIHierarchyTests: XCTestCase {
    private var journal: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        journal = XCUIApplication(bundleIdentifier: "com.fernandoamaral.bonds")
        journal.launch()
    }

    private func tap(_ label: String) {
        let element = journal.buttons[label].firstMatch
        XCTAssertTrue(element.waitForExistence(timeout: 15), "Missing: \(label)")
        for _ in 0..<8 {
            if element.isHittable { break }
            journal.scrollViews.allElementsBoundByIndex.last(where: { $0.isHittable && $0.frame.height > 200 })?.swipeUp()
        }
        XCTAssertTrue(element.isHittable, "Unreachable: \(label)")
        XCTAssertGreaterThanOrEqual(element.frame.height, 44, "Small target: \(label)")
        element.tap()
    }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: journal.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
        let hierarchy = XCTAttachment(string: journal.debugDescription)
        hierarchy.name = name + " accessibility"; hierarchy.lifetime = .keepAlways; add(hierarchy)
    }

    func testMainScreensAndProfileSections() {
        for label in ["Today", "People", "Calendar", "Settings"] {
            tap(label)
            capture("Main screen " + label)
        }
        tap("People")
        XCTAssertTrue(journal.buttons["Open Everclose Native QA"].waitForExistence(timeout: 15))
        XCTAssertFalse(journal.buttons["Browse allowed iPhone contacts"].exists)
        tap("Import from iPhone Contacts")
        XCTAssertTrue(journal.buttons["Browse allowed iPhone contacts"].exists)
        tap("Import from iPhone Contacts")
        tap("Open Everclose Native QA")
        for label in ["Overview", "Activity", "Details"] {
            tap(label)
            capture("Person " + label)
        }
        XCTAssertTrue(journal.buttons["Edit contact details"].exists)
        XCTAssertTrue(journal.buttons["Contact methods"].exists)
        tap("Overview")
        XCTAssertFalse(journal.buttons["Edit contact details"].exists)
        XCTAssertTrue(journal.buttons["Set reminder"].exists)
    }
}
