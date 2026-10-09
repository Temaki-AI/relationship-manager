# Personal iOS build 12

Status on 6 October 2026: source implementation and local validation pass. The
iPhone and simulator Release jobs, native startup and the full offline journey
pass in
[CI 37402857771](https://github.com/Temaki-AI/relationship-manager/actions/runs/37402857771).
The exact signed artifact is installed in place over build 10 on TIE Fighter;
fresh installed metadata confirms 1.0.0/build 12. The phone launch is denied
because iOS is locked. The user-ready simulator runs the exact build-12 Release
artifact as process 62204, and its account welcome screen was inspected. Its
schema-16-to-18 upgrade preserves every row in all 23 existing data tables and
all existing identity values; only the schema marker changes. Integrity and
foreign keys pass. No personal phone database was copied or reset.

Build 12 adds explicit verification and sharing of an original Apple Calendar
publication, including legacy private receipts and receipts held after a new
sign-in or CRM recovery. The owner first grants Calendar reads and verifies the
original event on the phone. Only its original marker, plan identity, current plan
fingerprint and publication status enter the shared protocol. EventKit identifiers,
event facts and private notes remain local. The server acknowledges the approved
device's verification report; it cannot independently inspect EventKit.

The new action never opens an editor, creates an event, releases an uncertain
publication or transfers its original publisher identity. A fresh review has its
own immutable operation identity and durable outbox. Unknown acknowledgements
retry exactly through restarts without reading Calendar again. Later private plan
edits and their existing CRM outboxes remain intact. A changed sign-in or recovery
epoch requires fresh review before a new request; old request bodies stay retained.

Native schema 18 adds one separate review table and preserves all 24 schema-17
data tables, account/installation identity, private source receipts, cursor values
and frozen core requests. Migration 50 adds immutable server review receipts and
guarded legacy adoption. Existing reservations retain their creation epoch and
publisher. Completed plans can receive verified publication status without changing
completion or interaction history. Review receipts stay outside CRM export/restore;
full workspace erasure removes them. No existing receipt is uploaded automatically.

All 955 root regression cases pass collectively: the restricted full run passes
953 and its two localhost readiness cases pass in their permitted rerun. The
initial loopback failures remain recorded. All 22 mobile package tests, mobile/root
types and lint, Hermes export, Cloudflare build and Worker dry run pass. The selected
real D1 run passes 39 cases with no skips; after strengthening the lost-reply case
to use a real queued plan edit, all eight native recovery cases pass again against
real D1. These tests use synthetic Calendar adapters and authenticated actual
middleware/dispatcher routing, not real Apple or Google account effects.

The independently verified [build-11 binaries](personal-ios-build11.md) cover the
preceding schema-17 reservation implementation. They do not contain schema 18.
The build-12 device artifact reports version 1.0.0/build 12 and Xcode 26.4.1/build
17E202. CI merge `130e649947d17fba2871eeef6a2810ca280c2546` has no file differences
from source `3c5e6cce21889aded7ce6e4cacef722c3461ff85`. Archive checksum and native
linkage pass. Local signing uses the existing profile (four eligible devices,
expiry 25 July 2027), without exporting keys or creating developer resources.
Strict verification passes again after extracting the final IPA, and the original
JavaScript bundle retains SHA-256
`7b4f442096f0f346ebead8e6131038757003628555230274dc67a4273957c271`.

| Artifact | SHA-256 |
| --- | --- |
| Device archive | `a32f2cc13ce4260f97f0338196044e7cb250dc2a02fa0d5a1dc6465297724849` |
| Simulator archive | `be5d94bce474983f0f54d6c74f4f8056fd352d5f1f77b5ef875787860787345f` |
| Signed IPA | `5e3698a531beaf6cf52c938138cbc7b850cbdf4fb914944839a160c861a16098` |

The downloaded XCTest result independently reports one pass, zero failures/skips,
and `testOfflineJournalAndRestart()` taking **445.068 seconds**. The downloaded
first-launch screenshot was inspected and shows the Google account welcome screen.
The simulator archive matches the same CI merge, reports build 12 and passes its
checksum/native-linkage verification. Its original bundle hash is
`c7ef81c591a3410bbfdd38943dd06303c40e281574569068bb9d68a5a22a38fc`.

The existing local-only QA simulator (four explicitly named QA fixtures) upgrades
from schema 16 to 18 using the unmodified CI binary. Fingerprints of every row in
all 23 original data tables remain identical; installation/account metadata remain
byte-identical except `schema-version`. Both new outboxes are empty. SQLite integrity
and foreign keys pass. The app was verified running as process 32585;
its Today screen was inspected before the QA simulator was shut down, preserving
the fixtures. This proves test-cache continuity, not the owner's phone field equality.

The compatible Calendar-only server is deployed from
`d8fb137eb1096203f743dfb7c91a71718f1fab99` as Worker
`ac198899-e378-48d1-b9c4-3fea9a83d436`. The owner explicitly approved the private
production backup. Rehearsal and post-migration comparisons preserve all original
fields across 69 production tables. The exact Calendar migrations 49 and 50 and
their journal entries are applied; Gmail migrations 45–48 are a separate rollout.
Live readiness passes, native Calendar/core endpoints require authentication, and
the existing signed-in web session opens successfully. This server's 814 cases
pass collectively, along with 31 Calendar and three Today cases on real D1,
types/lint, compilation and dry run. See [the completed rollout](calendar-server-rollout.md).

Google/EventKit identity review of the same event, arbitrary selected Apple event
context, real provider and physical Calendar pilots, owner field continuity and
phone/web round trips remain open. Google data OAuth is unconfigured; dependency
audits and public distribution remain separate release gates. The broader
[development plan](product-development-plan.md) remains active.

Private validation logs use `/private/tmp/everclose-build12-*.log`; durable local
delivery receipts are kept in the ignored `apps/mobile/build/releases/build12-personal-delivery/`
directory. The approved raw production backup stays at its private `/private/tmp/`
destination and is not copied into release artifacts or Git.
