# Everclose personal iOS build 10 — installed 6 October 2026

Version 1.0.0/build 10 upgrades **TIE Fighter** iPhone 13 in place from build 9.
Installation and fresh installed metadata pass. The subsequent launch request is
explicitly denied by iOS because the phone is locked; build-10 launch and process
stability are not yet verified. The owner has been asked to unlock the phone.
No personal database was copied or reset. Contact visibility was owner-confirmed
on build 7; current phone field equality and a fresh phone/web preference round
trip remain unverified.

The **Everclose Build 10** iPhone 17 Pro / iOS 26.2 simulator runs the unmodified
compiled release as process 13847. Its actual welcome screen was inspected,
including the preserved pending sign-in continuation. All 23 data tables and
installation identity are unchanged from build 9, with schema 16, zero contacts
and SQLite integrity intact. No Google account was selected on this simulator.
The separate synthetic QA simulator remains shut down and unchanged.

## Release changes and provenance

Build 10 upgrades the image and URI decoders through scoped dependencies and
small reproducible Metro/query-string adapters. Expo, React Native, Router and
native module versions remain unchanged. Today preferences and all build-9
features remain included. See [dependency security](dependency-security.md).

Compiled source: `3982c0d400fd81536cda1a8ceb42b89e452d7dac`.
CI merge: `7a7ff5779ebbf081fe1eed1c2810e100f192a07a`.
GitHub comparison verifies identical source trees. Both artifacts use Xcode
26.4.1/build 17E202, bundle `com.fernandoamaral.bonds`, version 1.0.0/build 10.
The subsequent local Google setup commit `57fd622` changes no app, domain or
native test source; it is not substituted for the compiled artifact's provenance.

| Artifact | SHA-256 |
| --- | --- |
| Device archive | `1f9591981e5df5cd2e5b84736b46773b6bc9e37b9d372f2680556623e7c32b77` |
| Simulator archive | `71a3c15d878fdc76c6221cf5f47384f80a433e974884fb8f8c20be6307a504ec` |
| Locally signed IPA | `0720bb248dbb469b24559ae764e777a9ecffdf6f34a219fa173c98e08aa4d6e6` |

The signed device JavaScript bundle retains the original archive's exact hash.
Strict signature verification passes using the existing local development
identity and profile (four eligible devices, expiry 25 July 2027). No signing key
or certificate was exported or uploaded, and no developer resource was created.
A restricted signature check could not access signing trust; the same strict
verification succeeds with access to the existing trust configuration.

## Verification and remaining work

- [Native CI 37391200805](https://github.com/Temaki-AI/relationship-manager/actions/runs/37391200805)
  passes both Release builds, linkage, real SQLite/Keychain startup and the full
  offline contact/draft/plan/history/reminder journey. The downloaded XCTest
  result independently reports one pass, zero failures/skips, in **452.447 seconds**.
- Clean installation applies both parser patches. All 22 mobile package checks,
  mobile types/lint, Hermes export and seven foundation/supply-chain checks pass.
- The subsequent local Google setup passes all 919 root tests, including nine
  development/import checks, plus root types and full lint. It imports no real
  credential and changes no provider, Worker or production database.
- [General CI 37391200731](https://github.com/Temaki-AI/relationship-manager/actions/runs/37391200731)
  passes 913 root cases, 398 D1 cases with 11 documented skips, and 14 cloud browser
  journeys. Cloud validation passes; general validation fails at the unchanged
  dependency-audit gate. Root audit still reports seven high affected packages;
  mobile audit reports 22 high and zero moderate. Braces/node-forge remain unresolved.

Private evidence stays beneath `apps/mobile/build/releases/`: the matching
`build10-ci-398-device/` and `build10-ci-398-simulator/` artifact receipts,
`build10-ci-398-offline.xcresult`, `build10-phone-install/` installation/signing/lock
records, `build10-local-google-setup/` test receipts and the signed
`Everclose-1.0.0-ios-build10-3982c0d.ipa`. Packages, caches, credentials and receipts
remain ignored by Git.

The hosted Today extension remains Worker `370949af-afef-44e2-8578-900625e1ce0d`
on migration 44. Gmail migrations 45–48 and production bindings are undeployed.
Real provider/physical privacy/accessibility pilots, the owner round trip and
TestFlight/public distribution remain in the [development plan](product-development-plan.md).
The wider development goal remains active.
