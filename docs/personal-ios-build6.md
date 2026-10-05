# Everclose personal iOS build 6 — signed release, 5 October 2026

Build 6 is signed and ready for the registered development iPhone. Both native
Release jobs, linkage checks and isolated SQLite/Keychain startup pass in
[run 37321546205](https://github.com/Temaki-AI/relationship-manager/actions/runs/37321546205).
The verified first-launch screenshot was inspected and renders the Google account
welcome screen. Physical installation is still pending; build 4 remains the last
verified installation on TIE Fighter.

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

## Delivery gate

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
No physical contact database was copied. The shared local Simulator was not used.

Production remains at the last verified migration 44; local D1 has migration 48.
No new production migration, deployment, mailbox read or Google credential change
was made for this package. Google development-project/client approval is pending.
This personal development package does not establish TestFlight/App Store delivery
or completion of the full integrated beta. Private package, signing material,
screenshots and verification receipts remain ignored by Git.
