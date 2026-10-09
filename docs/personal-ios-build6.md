# Everclose personal iOS build 6 — signed release, 5 October 2026

Build 6 is signed and ready for the registered development iPhone. Both native
Release jobs, linkage checks and isolated SQLite/Keychain startup pass in
[run 37321546205](https://github.com/Temaki-AI/relationship-manager/actions/runs/37321546205).
The verified first-launch screenshot was inspected and renders the Google account
welcome screen. At the owner's request, build 6 is now installed and running in a
dedicated local iPhone simulator. The native offline contact/restart journey passes.
Physical installation is still pending; build 4 remains the last verified
installation on TIE Fighter.

The private package is `apps/mobile/build/releases/Everclose-1.0.0-ios-build6.ipa`,
SHA-256 `0f25d1a25cbe825d290d454c4d40492545494dbeaec5521c05e4ec14372844e9`.
Native and JavaScript source are `52dbdd07ccc8bc5dcb0a22e359221b037094b874`.
The compiled CI merge is `511fb95ee30c8b929e952e6ce38fa29f78d85803`; its mobile,
domain, native workflow and runtime configuration tree matches that source exactly.
The downloaded artifact checksum, native linkage, build number, hosted origin,
configured `bonds://auth` callback and Face ID description were verified. Strict
signature verification passes with macOS trust services. The signed JavaScript
bundle hash matches the compiled artifact.

Version is 1.0.0, build is 6, native schema remains 15, minimum iOS is 16.4 and the
native toolchain is Xcode 26.4.1. The existing development profile covers this phone
and expires on 25 July 2027. No signing key is exported or uploaded.

## Behavior and validation

The optional device lock starts off. Account & sync can enable Face ID, Touch ID
or device-passcode verification for all accounts and local-only data on this phone.
Startup loads the policy before mounting account data; warm drafts are retained
behind the lock. Late authentication is fenced, and unreadable policy can be repaired
only after device verification. See [native device lock](native-app-lock.md) for
behavior and limitations. It is a UI gate, not database encryption, screen-capture
prevention or notification-preview protection.

Existing Today, People, profiles, photos, history, notes, plans, reminders, iPhone
Contacts and Calendar functionality remains in this package. Frozen CRM version-4
sync requests and existing account caches remain compatible. The default-off Gmail
metadata cache from build 5 is retained; its server deployment and real-account
provider pilot remain separate requirements.

The current source passes 878 root tests with no skips, 398 D1 tests with 11
documented large-count/trigger-fault cases covered by SQLite, 17 mobile package
tests including 12 lock-controller scenarios, and all 157 existing native data/sync
regressions. Root/native types and lint, Hermes export, cloud build and browser
journeys pass. General CI in
[run 37321546195](https://github.com/Temaki-AI/relationship-manager/actions/runs/37321546195)
then fails at the existing `npm audit --audit-level=moderate` gate; it is not green.
These findings remain a public-release requirement.

## Local simulator delivery

The downloaded simulator package from run 37321546205 has SHA-256
`131aa7f45ec9df52d70724e9f28c67bfe0696b489abca3afc7b4c24d634b4b9e` and the same
verified source/CI merge recorded above. Its platform, build number and native
linkage pass. It runs on the local iPhone 17 Pro / iOS 26.2 simulator named
**Everclose Build 6 QA**. This is an already compiled app; the local Xcode 26.2
toolchain compiled only the small XCTest host, not the Expo SDK 57 application.
Startup verifies schema 15, SQLite integrity, the Keychain installation marker
and zero contacts. Process stability and the actual first-launch screen pass.

A second dedicated simulator, **Everclose Native UI QA**, holds only the synthetic
`Everclose Native QA` contact with an `example.invalid` email. XCTest operates the
actual build-6 binary through taps, typing and scrolling. The final offline run
passes **one native journey, zero failures and zero skips**: first-run local-only
choice, Today/Agenda/Reminders/People navigation, exact saved name/email/notes
after terminate/relaunch, and the default-off device-lock control. The initial
diagnostic run exposed a test locator mismatch for the multiline Notes field;
the final test uses its observed accessibility label and asserts exact input
values. These checks do not establish real notification, Calendar permission or
biometric behavior. The repeatable harness is in
[tests/native-ui](../tests/native-ui/README.md).

A separate live navigation check passes **one journey, zero failures and zero
skips**: Continue with Google opens the iOS permission prompt for
`everclosecrm.com`, then the hosted Google-login page; browser cancellation returns
to the native welcome screen. The passing result is
`build6-hosted-sign-in-attempt2.xcresult`, and its screenshots were inspected.
The initial run left the permission prompt open; the final harness explicitly
verifies that the system button is reachable and the prompt closes before checking
the page. No Google account was selected and no device grant was created.
Cancellation retains the app's pending sign-in continuation; a new sign-in can be
started with Continue with Google. Actual authenticated sync remains unverified on
these local simulators and does not depend on creating a localhost OAuth client.

Private results remain under `apps/mobile/build/native-ui/`; the passing bundle
is `build6-offline-attempt2.xcresult`. Artifact and simulator receipts stay under
the ignored release directory. No owner credentials or personal database were
copied to either simulator. Other projects' simulators were not changed. The Mac
is locked, so no foreground Simulator window is claimed; headless native XCTest
and simulator screenshots provide the actual UI evidence.

## Physical delivery gate

The delivery connection check still reports no available CoreDevice tunnel or
developer services, with the cached last connection at 10:57 UTC. The focused macOS
USB inventory check did not detect an iPhone. No build-6 installation was attempted
against this unavailable connection. The owner has been asked to unlock both Mac
and iPhone, connect directly by USB and accept Trust if prompted.

Reuse this verified package once connected. Install the extracted signed app in
the ignored `build6-installation/Payload/Everclose.app` directory, then verify the
exact bundle/build metadata, launch and process stability. Physical account/data,
phone/web round trips, photo/Calendar actions, closed-app reminders, biometric and
passcode prompts, native-editor masking and VoiceOver still require verification.
No physical contact database was copied. The owner's later instruction to use
Simulator is fulfilled through the separate local devices above; USB reconnection
is only needed for the physical follow-up.

Production remains at the last verified migration 44; local D1 has migration 48.
No new production migration, deployment, mailbox read or Google credential change
was made for this package. Google development-project/client approval is pending.
This personal development package does not establish TestFlight/App Store delivery
or completion of the full integrated beta. Private package, signing material,
screenshots and verification receipts remain ignored by Git.
