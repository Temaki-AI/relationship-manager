# Everclose personal iOS release — 4 October 2026

Everclose 1.0.0 (build 1) has been compiled as native iOS binaries and installed
on the owner's paired iPhone, **TIE Fighter** (iPhone 13, iOS 18.6.2). The bundle
identifier remains `com.fernandoamaral.bonds` and the sign-in callback remains
`bonds://auth`, preserving the existing account/storage protocol.

## Build and installation evidence

- [Native release build](https://github.com/Temaki-AI/relationship-manager/actions/runs/37227031535)
  compiled both arm64 simulator and device apps using Xcode 26.4.1, including the
  custom Swift/EventKit module. The build runs native TypeScript, unit tests and lint.
- Native source commit: `cbe2caf9064411f019c9d05263fd10826874d281`.
  The initial CI merge commit has the same source-tree hash. The final embedded
  JavaScript comes from `572d88b1a58757e55bcd102a25c03895b5276052`.
- Both release apps include a bundled Hermes program and support iOS 16.4+.
- The downloaded artifacts' SHA-256 checksums match the build manifests.
- The device app was signed locally using the existing Apple development identity
  and matching wildcard development profile. All embedded frameworks and the app
  pass `codesign --verify --deep --strict`.
- No signing key/certificate was exported to GitHub or another build service.
- Apple's `devicectl` reports successful installation on TIE Fighter. The device
  is registered in the profile and already has Developer Mode enabled.
- Automatic launch was refused because the physical iPhone is locked. Unlock,
  native Google approval, first download and a real phone/web edit remain to verify.
- The corrected simulator binary was built in
  [the recovery run](https://github.com/Temaki-AI/relationship-manager/actions/runs/37234498354),
  then installed and launched on this Mac's iOS 26.2 simulator. Its real SQLite
  database is schema 14, passes integrity checks, contains zero contacts, is bound
  to `local-only`, and contains the installation marker written after successful
  native Keychain access. The Google sign-in welcome screen renders correctly.
- The recovery run's hosted runtime check timed out during Apple's CoreLocation
  data migration before the app could start. It did not pass. Compilation and local
  startup are verified independently; the workflow now allows a bounded 10-minute
  cold boot. Interactive contact/editor and authenticated phone/web journeys are
  still pending because both the Mac and iPhone locked during this work.

The development IPA is saved privately in
`apps/mobile/build/releases/Everclose-1.0.0-final-development.ipa` (ignored by Git).
It can run on the four devices already registered in its profile, which expires
25 July 2027. This is a development installation, not a TestFlight submission.

## Native startup correction

The first unsigned simulator package launched but could not use Keychain. Adding
iOS entitlements to a post-build macOS code signature is not a valid simulator fix:
Xcode must generate the simulator's entitlement section while linking. The native
workflow now enables Xcode's ad hoc simulator signing and verifies the real app's
fresh SQLite database reaches schema 14 with an empty contact table and clean
integrity check. The device package uses the actual development profile and proper
device entitlements.

The final account callback opens People after the workspace navigator is ready,
and People displays download progress or a recoverable sync error before the first
contact download. The final package includes this correction and has been
successfully installed over the initial phone candidate.

## Account and daily use

First launch offers **Continue with Google** against `https://everclosecrm.com`,
which already has the device authorization and version-4 sync endpoints deployed.
Approve this iPhone to download the existing workspace. The app uses Keychain for
the revocable phone session and an account-specific SQLite cache. Contacts, methods,
interaction history, reminders, plans, family and relationship context work offline;
saved Google Calendar context downloads when available. Sync runs while the app is
open and on resume. The optional local-only workspace stays separate.

People can create/edit CRM contacts or review a selected iPhone contact. Agenda
can open the native Apple Calendar event editor for a reviewed plan. Calendar read
permission and optional date following are separate user choices. Creating CRM
test contacts in the local-only workspace does not upload them to the live account.

## Rebuild and distribution

The [iOS binary workflow](../.github/workflows/ios-build.yml) runs on GitHub's
arm64 macOS 26 runner using Xcode 26.4.1. It can be dispatched on the development
branch without changing the live web deployment. Download the simulator/device
artifacts and extract their ZIP files using `ditto` to preserve executable modes.
The device artifact is deliberately unsigned until signed on this Mac.

`apps/mobile/scripts/sign-development-ios.py` signs an extracted device `.app`
using an existing local identity and provisioning profile, then produces a private
IPA. It rejects expired/incompatible profiles and existing output files. Use
Apple's `devicectl device install app` with the extracted signed app to install it.

`scripts/refresh-ios-bundle.mjs` embeds committed JS-only fixes using Expo's native
Hermes bundle command. It refuses changed native dependencies, configuration,
assets or Swift modules compared with the supplied native build commit, and refuses
uncommitted/untracked app sources. Both final apps contain `EvercloseRelease.json`
with the native/JS source commits and bundle SHA-256. Device apps must be signed
again after refreshing the bundle; simulator entitlements stay in Xcode's Mach-O
section rather than the host code signature.

TestFlight requires a distribution identity/profile and an App Store Connect app
record; those have not been created. The separate Google Contacts/Calendar data
clients are still unconfigured on the server, and Gmail is not implemented. LinkedIn
support uses reviewed exports/profile links. Native photo transport, broader
pagination, accessibility and the complete integration pilot remain in the
[product plan](product-development-plan.md).

The dependency audit currently reports advisories in the Expo/Metro build dependency
tree, including inherited advisories on React Native packages. The build is not
claimed to pass the audit. Do not use `npm audit fix --force`: its proposed SDK/RN
downgrades would break this app's native API contract. Review compatible dependency
updates separately before a public distribution.
