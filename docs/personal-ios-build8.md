# Everclose personal iOS build 8 — delivered 5 October 2026

Version 1.0.0/build 8 is installed in place on the owner's **TIE Fighter** iPhone
13 and is running as process 14545. Fresh installed metadata, the installation
receipt, successful launch and a subsequent process query verify delivery. The
personal database was not copied or reset. The owner confirmed existing contact
visibility on the preceding build 7; build-8 field equality, visibility and a fresh
phone/web sync round trip have not yet been independently verified.

The **Everclose Build 8** iPhone 17 Pro / iOS 26.2 simulator also runs the unmodified
compiled release, as process 63529. Its welcome screenshot was inspected. Its
existing empty local-only cache retains schema 15, passes SQLite integrity, and
preserves the original installation-marker identity. Synthetic QA fixtures stay
on a separate, shut-down simulator.

## Changes

Today offers up to eight people, with one card per person, combined reminder,
birthday and check-in reasons, and the latest recorded interaction. Reach out
opens saved contact methods; only explicit Log records a conversation. Done and
Snooze use the same durable reminder handlers on Today and Reminders. Reminder
changes do not remove independent birthday/check-in reasons.

Choice lists scroll with a persistent Cancel control, including at the largest
accessibility text size. They close when the journal is backgrounded or locked.
Standard Apple contact-method labels display clearly while their original stored
values and custom labels are preserved. Native schema 15 and the frozen version-4
CRM sync contract are unchanged.

## Compiled release and validation

Source commit: `3d39dcd1334874544bc4e41505ab4717745ab9ac`.
CI merge commit: `c0e369daba6a1f756a1cfc0169fff691408a0be8`.
GitHub's comparison confirms the merge adds no file changes to that source.
Both artifacts compile with Xcode 26.4.1/build 17E202.

[Native CI 37371940722](https://github.com/Temaki-AI/relationship-manager/actions/runs/37371940722)
passes both Release binaries, linkage, actual SQLite/Keychain startup and the
complete native offline contact/draft/plan/history/reminder journey through
restarts: one test, zero failures/skips, 329.156 seconds. The downloaded result
bundle independently reports one passing test and no failures/skips.

Two additional local native checks run against the **unmodified compiled build 8**
on the retained synthetic QA simulator. Background closure passes in 29.047
seconds; largest-text actions and persistent Cancel pass in 32.289 seconds. Both
have zero failures/skips. The picker screenshot was inspected. All 21 data tables
are identical before and after the upgrade/checks. Metadata keys and values are
unchanged; only `device-source-installation.updated_at` refreshes on startup.
The four synthetic contacts, source facts, history, reminders and durable intents
are preserved. QA text size is restored and that simulator is shut down.

The earlier [Today preview](native-today.md) separately verifies cancellation
without history and explicit Snooze/Done/Log persistence. Its provenance remains
distinct from these actual compiled-release results.

Source checks verify all 898 root cases: 896 pass in the full restricted run, and
the two readiness tests blocked from binding their loopback server pass in a
separate permitted rerun. Thirty focused cases, 17 mobile package tests, both
TypeScript checks and full root/mobile lint pass. General runs 37371940769 and
37371935667 pass their Cloudflare build/browser jobs, but each validation job is
cancelled before any step because GitHub could not acquire a hosted runner after
multiple attempts. These are not green general CI runs. Dependency remediation
and complete broader CI remain open; no audit threshold was lowered.

## Packages and private evidence

| Package | SHA-256 |
| --- | --- |
| Original device archive | `5afe297ff9e90dfc354b426a9ad4cc1e7b3c3b29cd493ae8e4be79c8f25676aa` |
| Original simulator archive | `fdd7aa4f45c54770e33628a3c5e7f9205c3e1fcc088735c448ea507bdd2e09dd` |
| Signed personal IPA | `aa8af9f68b25c291f8a7b821749580312b08c4a2b44be8dd232c7f9eca02e4b8` |

The IPA is `apps/mobile/build/releases/Everclose-1.0.0-ios-build8.ipa`. Strict
signature verification passes using the existing local development identity and
profile, which covers four registered devices and expires 25 July 2027. No signing
key was exported or uploaded. Signing changes no compiled JavaScript.

Ignored private evidence is under `apps/mobile/build/releases/build8-ci-device/`,
`build8-ci-simulator/` and `build8-phone-install/`. The phone directory retains
installation, installed-metadata, launch, process-stability and delivery receipts.
The native result bundles are `apps/mobile/build/native-ui/build8-ci-offline.xcresult`
and `build8-release-today-readonly.xcresult`, with the latter's exported attachments.
The CI log is `/private/tmp/everclose-build8-green-native-ci.log`.

This is a working personal development installation. Google sign-in and provider
authorization use normal owner-controlled flows; this delivery selects no owner
account or new provider grant. Production remains migration 44. Shared prompt
snoozes, current-account/provider pilots, physical privacy/accessibility checks,
Gmail rollout, the week-long personal pilot and TestFlight/public release remain
in the [product plan](product-development-plan.md). The full development goal
remains active.
