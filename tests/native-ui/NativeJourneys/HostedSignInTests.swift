import XCTest

/// Uses a fresh, unauthenticated simulator. Stops before Google account consent.
final class HostedSignInTests: XCTestCase {
    override func tearDownWithError() throws {
        let screenshot = XCTAttachment(screenshot: XCUIApplication(bundleIdentifier: "com.fernandoamaral.bonds").screenshot())
        screenshot.name = "Unauthenticated sign-in result"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    func testHostedLoginAndCancellation() throws {
        continueAfterFailure = false
        let journal = XCUIApplication(bundleIdentifier: "com.fernandoamaral.bonds")
        journal.launch()
        let signIn = journal.buttons["Continue with Google"].firstMatch
        XCTAssertTrue(signIn.waitForExistence(timeout: 20))
        signIn.tap()

        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let permission = springboard.alerts.firstMatch
        if permission.waitForExistence(timeout: 5) {
            XCTAssertTrue(permission.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "everclosecrm.com")).firstMatch.exists)
            let proceed = permission.buttons["Continue"]
            for _ in 0..<3 {
                guard proceed.exists else { break }
                XCTAssertTrue(proceed.isHittable)
                proceed.tap()
                _ = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: proceed)], timeout: 3)
            }
            XCTAssertFalse(proceed.exists, "The native authentication permission prompt did not close")
        }

        let welcome = journal.webViews.staticTexts["Welcome back to Everclose CRM"].firstMatch
        XCTAssertTrue(welcome.waitForExistence(timeout: 30), "Hosted login did not load in the authentication browser")
        XCTAssertTrue(journal.webViews.buttons["Continue with Google"].exists)
        let screenshot = XCTAttachment(screenshot: journal.screenshot())
        screenshot.name = "Hosted sign-in before Google account consent"
        screenshot.lifetime = .keepAlways
        add(screenshot)

        // Cancel through the authentication browser, without authorizing an account.
        let cancel = journal.buttons["Cancel"].firstMatch
        XCTAssertTrue(cancel.exists)
        cancel.tap()
        XCTAssertTrue(signIn.waitForExistence(timeout: 15))
        XCTAssertTrue(journal.buttons["Use only on this iPhone"].exists)
    }
}
