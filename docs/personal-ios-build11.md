# Personal iOS build 11 candidate

Status on 6 October 2026: both native Release builds, startup and the complete
offline journey pass in [CI 37399778847](https://github.com/Temaki-AI/relationship-manager/actions/runs/37399778847).
Build 11 is compiled, but has not been signed locally or installed. Build 10 remains
installed on TIE Fighter and runs in the Everclose Build 10 simulator; the current
phone launch remains blocked by its device lock.

This candidate adds shared Calendar publication reservations, minimal shared
status review, and a durable native acknowledgement outbox. It retains offline
Calendar drafting and original event verification. Opening a new system editor
requires an online reservation followed by durable attempted authorization. A
lost HTTP reply, native reply or restart cannot reopen an attempted editor.
Calendar facts, private notes and Apple event identifiers remain on the phone.

Native schema 17 preserves the existing 23 schema-16 data tables, installation and
account identity, original EventKit receipts and frozen CRM outboxes, adding a
separate reservation table. The core cloud sync protocol remains version 4.
Expo 57, React Native 0.86, native modules and dependency adapters are unchanged.

See [Calendar coordination](calendar-publication-coordination.md) for the exact
implemented boundary and outstanding legacy/recovery/source-identity work.
The matching server migration 49 and endpoint are still undeployed. Build 11 must
report the unavailable-server gate truthfully until a verified matching rollout.
It must not replace the working personal installation before that compatibility
check and native Release validation.

Verification includes 939 regression cases and an additional actual middleware/
dispatcher journey, all passing with zero skips. The 23 native Calendar cases
include lost reserve/attempt/result/cancellation/release replies and restart.
Real disposable D1 passes 23 selected Calendar cases and the additional routing
journey. All 22 mobile package tests, mobile/root types and lint, Hermes export,
Cloudflare build and Worker dry run pass. The downloaded XCTest result independently
reports one pass, zero failures/skips, with `testOfflineJournalAndRestart()` taking
430.760 seconds. Device and simulator artifacts report version 1.0.0/build 11,
Xcode 26.4.1/build 17E202 and CI merge
`fbb98ee60d974875c8f77004d2ac51c629e14e48`. GitHub comparison finds no changed files
against source `88282f2f7108b9cad451cee53c437663b0f66919`. Both archive checksums and
native linkage pass; their original JavaScript bundles have not been replaced.

| Artifact | SHA-256 |
| --- | --- |
| Device archive | `8368c3fba3311109208600b65b6696076cf3681279d344e8f6eb8c84bcd084b8` |
| Simulator archive | `7c8709d7d3e4dacabc58873544d8ea7a980f9d776a90af775f82ccb531ed39f7` |

Local signing, installation and launch remain unverified for this candidate.
Build-12 recovery changes are separate source work and are not covered by these
build-11 binaries.

Private local evidence uses `/private/tmp/everclose-calendar-coordination-*`,
`everclose-calendar-final-native-cases.log`, `everclose-calendar-reservation-d1-serial.log`
and `everclose-calendar-actual-routing-d1.log`. Failed initial fixture/version checks
and local loopback failures are retained alongside the successful reruns. No
failed run is described as passing.

No production database, OAuth configuration, phone database or existing personal
installation was changed by this source work. Real provider pilots, owner/week
pilot, accessibility/privacy checks, Gmail server rollout, unresolved dependency
audits and public distribution remain open in the development plan.
