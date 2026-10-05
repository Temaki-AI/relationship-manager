import SwiftUI

// XCTest's small host does not replace or compile the Everclose application.
@main
struct NativeTestHost: App {
    var body: some Scene {
        WindowGroup { Text("Everclose native test host") }
    }
}
