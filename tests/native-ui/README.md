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
everclose_qa_app="$PWD/apps/mobile/build/releases/build7-ci-simulator/extracted/Everclose.app"
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
  -test-timeouts-enabled YES -default-test-execution-time-allowance 600 \
  -maximum-test-execution-time-allowance 600 \
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
default-off device-lock control. It also closes and resumes an edited contact
draft, creates and completes a plan with confirmed timeline history, and creates,
snoozes and completes a reminder through restarts with notifications denied.
Character-by-character public XCTest typing and exact value assertions make
simulator input failures visible. The current complete journey requires build 7
or later, which adds native Snooze. Build 6's shorter passing journey is preserved
at test-harness commit `7930055` and in its private result bundles.

The native build workflow runs this offline journey against its actual compiled
Release app after startup/linkage verification. It saves an `.xcresult` artifact
on success or failure. Hosted sign-in is excluded from this offline CI gate.

`HostedSignInTests` is a separate **live network** check. Run it on its own clean
simulator by changing `-only-testing` to `NativeJourneys/HostedSignInTests`. It opens
the system authentication browser, checks the Everclose hosted Google-login page
and cancels before selecting a Google account or authorizing device access. It
does not prove authenticated sync, provider consent or account-data continuity.
Keep any authentication-browser screenshot private.

`NotificationDeliveryTests` is a separate local-notification check on a disposable
simulator containing only the known synthetic fixture. `testPrepareNotificationFixture`
creates its contact/reminder and accepts the native permission prompt. Before
`testObserveClosedAppDelivery`, the host sets that synthetic reminder and its pending
create intent to the same near-future time, launches the app, verifies the matching
native scheduling receipt, and terminates it. Never retime an owner/account database.
The observer asserts the app is not running, waits for the OS notification and
preserves its visible screenshot and accessibility hierarchy. This controlled
fixture check is not part of the offline CI gate or evidence of physical delivery.

Run native UI sessions serially. Concurrent UI runners on this Mac exhausted host
memory/disk space and interrupted one delivery attempt. Build 7's full offline,
first-permission, closed-app delivery and hosted-login tests all pass against the
unmodified compiled CI artifact in separate runs. The corrected input helper uses
native Select All and exact value checks rather than relying on Command-A, which
did not reliably select the date field. The original CI run's failing input step
remains recorded; a passing local harness does not change that CI conclusion.

`DeviceContactsTests` uses the real iOS Contacts framework and system picker on a
dedicated, synthetic-only QA simulator. Run `testReviewedCreateAttachRestartAndUnlink`
first on a fresh Everclose local-only cache. The separate test host requires both
`--contacts-fixture` and `EVERCLOSE_SYNTHETIC_CONTACTS_QA=1`, refuses physical devices,
and creates or verifies only two exact synthetic records. Grant Contacts access to
the helper only; Everclose must receive its permission through the actual OS UI.
iOS 26 calls full access **Share All <count> Contacts**. The journey creates a
person first and attaches a reviewed source, then creates another person from a
different reviewed source. It waits for confirmed unlink before restarting.

After the first journey, revoke Contacts permission for Everclose on that exact
QA simulator and run `testDeniedContactsKeepsSavedRelationship` separately. Its
helper uses `--verify-contacts-fixture` to check existing fields and labels without
creating records, updating a receipt or requesting broader access. Compare the
synthetic CRM tables before and after denial. Never seed, reset or retime an owner
cache or use a physical address book. Limited-access behavior remains a separate
check. A later `testSavedContactLabelsAreReadableWithoutRewritingOriginals` checks
the display fix against the retained synthetic data; it needs the updated app.

Automatic per-keystroke screenshots are disabled; explicit screenshots and
accessibility hierarchies remain. Failed XCTest runs can still collect large OS
diagnostics. Reserve enough disk space, keep the failure log/compact summary, and
stop the failed runner before cleaning an incomplete generated result bundle.
Passing results and release archives must remain available.

Execution evidence and the remaining physical checks are recorded in the
[build-6 release record](../../docs/personal-ios-build6.md) and
[build-7 source/release record](../../docs/personal-ios-build7.md).
