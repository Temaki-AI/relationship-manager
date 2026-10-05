# Native iOS journeys

These XCTest journeys operate the compiled Everclose app through native taps,
typing, scrolling and process restarts. The small SwiftUI test host does not build
or replace Everclose. Use a **new, dedicated simulator with no account or personal
data** for each full run. The offline journey writes one synthetic contact.

Requirements: macOS, Xcode with an installed iOS simulator runtime, XcodeGen and
an already compiled `iphonesimulator` Everclose `.app`. The app bundle identifier
must be `com.fernandoamaral.bonds`. A signed device `.ipa` cannot run in Simulator.
Expo SDK 57 app compilation requires the supported Xcode toolchain; running this
small test harness against a verified precompiled app does not compile Expo.

Run from the repository root, using the runtime installed on this computer:

```sh
(
set -e
everclose_qa_app="$PWD/apps/mobile/build/releases/build6-ci-simulator/extracted/Everclose.app"
everclose_qa_runtime=com.apple.CoreSimulator.SimRuntime.iOS-26-2
everclose_qa_output="$PWD/apps/mobile/build/native-ui/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$everclose_qa_output"
everclose_qa_id=$(xcrun simctl create 'Everclose disposable native QA' \
  com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro "$everclose_qa_runtime")
trap 'xcrun simctl shutdown "$everclose_qa_id"' EXIT
xcrun simctl boot "$everclose_qa_id"
xcrun simctl bootstatus "$everclose_qa_id" -b
xcrun simctl install "$everclose_qa_id" "$everclose_qa_app"
xcodegen generate --spec tests/native-ui/project.yml
xcodebuild build-for-testing \
  -project tests/native-ui/EvercloseNativeQA.xcodeproj -scheme EvercloseNativeQA \
  -destination "platform=iOS Simulator,id=$everclose_qa_id" \
  -derivedDataPath "$everclose_qa_output/DerivedData" \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-
xcodebuild test-without-building \
  -project tests/native-ui/EvercloseNativeQA.xcodeproj -scheme EvercloseNativeQA \
  -destination "platform=iOS Simulator,id=$everclose_qa_id" \
  -derivedDataPath "$everclose_qa_output/DerivedData" \
  -parallel-testing-enabled NO -maximum-concurrent-test-simulator-destinations 1 \
  -test-timeouts-enabled YES -default-test-execution-time-allowance 180 \
  -maximum-test-execution-time-allowance 240 \
  -only-testing:NativeJourneys/OfflineJournalTests \
  -resultBundlePath "$everclose_qa_output/offline.xcresult"
xcrun xcresulttool get test-results summary \
  --path "$everclose_qa_output/offline.xcresult" --compact
)
```

Inspect the result before deleting the disposable simulator. The shutdown trap
only targets the simulator created by this command; it does not affect other
projects' devices. Generated project files, build products, screenshots and result
bundles stay ignored by Git.

`OfflineJournalTests` checks first-run local-only navigation, all four main tabs,
exact saved name/email/notes after terminating and reopening the app, and the
default-off device-lock control. Character-by-character public XCTest typing and
exact value assertions make simulator input failures visible.

`HostedSignInTests` is a separate **live network** check. Run it on its own clean
simulator by changing `-only-testing` to `NativeJourneys/HostedSignInTests`. It opens
the system authentication browser, checks the Everclose hosted Google-login page
and cancels before selecting a Google account or authorizing device access. It
does not prove authenticated sync, provider consent or account-data continuity.
Keep any authentication-browser screenshot private.

Build-6 execution evidence and the remaining physical checks are recorded in
[the personal release record](../../docs/personal-ios-build6.md).
