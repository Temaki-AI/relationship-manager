# Shared Calendar publication coordination

Status on 6 October 2026: build 11 passes both native Release builds, startup and
the full offline journey; build-12 source adds explicit legacy/recovery verification.
Production remains on migration 44 and the phone/simulator retain verified build
10. Migrations 49–50 and these native candidates have not been deployed or installed.
Shared publication coordination is not live.

New system Calendar publications acquire an account-wide reservation before
opening Apple's editor. Google publication preparation acquires the same plan
slot atomically. A competing phone or web publisher retains its draft and reviews
the original publication. Only an unopened release or an explicit cancellation
reported by the originating editor frees a slot. Saved, attempted and uncertain
publications retain it without a timeout or automatic event recreation.

Draft review remains available offline. The editor confirmation explains that
Everclose shares the plan's publication status and requires a connection. EventKit
event/calendar identifiers, event titles, source facts, invitees, private notes and
history remain outside this API. Google and native clients derive the same plan
fingerprint from the existing canonical scalar fields; this changes neither the
CRM sync protocol nor the original private Apple receipt fingerprint.

Native schema 17 adds a separate account/session-bound reservation outbox. It
preserves all existing schema-16 rows, private EventKit receipts, account and
installation identity, cursor values and frozen version-4 CRM requests. Each
reserve, attempted-editor authorization, cancellation/release or saved result is
frozen before sending. An unconfirmed HTTP reply retains the identical request
through restarts. Foreground synchronization confirms at most eight pending
requests and never opens an editor. Only a fresh explicit editor action can resume
an acknowledged authorization while its private receipt still records no local
editor attempt. After the local attempted flag commits, creation cannot repeat.
The originating editor result and its shared-result request commit together.

The exact owner-authenticated `/api/v1/calendar-reservations` endpoint exposes a
minimal status projection. GET can be read by the current web owner or approved
device. POST accepts only approved owner devices and bounded exact bodies. Epoch,
current session expiry/revocation, open plan fields, known Calendar associations
and row revisions fence reservations/attempts. Native clients also retain their
local plan/account/association guards before the OS effect. An unavailable endpoint
leaves the draft intact and explains why the editor cannot yet open.

Migration 49 backfills existing Google publication identity before installing
its guards. It changes no previous application rows. Insert/update triggers make
Google preparation, uncertain writes and confirmations acquire/update the shared
receipt in the same transaction as the original operation. The receipt survives
plan removal, device revocation, provider removal and CRM restoration as evidence
of a possible external event. Restoration holds active claims; complete workspace
erasure removes them. Claims remain outside CRM backups and exports.

Approval of a device session identifies the publisher; it does not establish a
permanent physical-phone identity. Reauthentication and account recovery hold old
native requests. Automatic retries never transfer a claim to a new session or
release an unknown external effect. Existing build-10 Apple receipts stay private
and are not silently adopted. Build-12 source implements explicit legacy adoption
and fresh-marker reconciliation after a session/recovery change. A fresh consented
EventKit read verifies the original marker on the phone; the server acknowledges
the approved device's report, without independently reading Apple Calendar. Native
schema 18 and cloud migration 50 retain immutable verification requests, preserve
the original publisher/creation epoch and permit safe acknowledgement retries
without another provider read or write. Existing receipts and core edit outboxes
remain unchanged, including later private edits. Identity review of one event
observed through both Google and EventKit remains beta work. The present flow coordinates new
publications by upgraded clients; it cannot prevent a legacy/offline build-10
editor or an independently created external event.

The focused checks cover competing publishers, a real authenticated cross-layer
native/server sequence, immutable retries, lost replies at each stage, cancellation
and discard acknowledgements, account changes, restore/erasure, Google backfill,
and all-row native migration preservation. The real disposable D1 run passes
23 Calendar tests with no skips. An additional actual middleware/dispatcher journey
passes against SQLite and real disposable D1, verifying approved sessions and
rejection of unknown/revoked sessions, extra paths and hostile origins. All 939
regression tests pass with zero skips; the subsequent routing journey also passes.
Native cancellation/release acknowledgement checks pass, and all 22 mobile package
tests, types, lint, Hermes export, Cloudflare build and Worker dry run pass. Final
native release evidence belongs in
[the build-11 record](personal-ios-build11.md). Build-12 validation is recorded
separately in [its candidate record](personal-ios-build12.md); the schema-17 binaries
do not establish native Release validation for schema 18.

Before rollout, rehearse production's migration-44-to-current upgrade using a
recoverable backup and verify the matching middleware/Worker routing. Compile
both native Release targets and inspect their startup/offline results. An owner
pilot must check real Calendar permission/editor effects, marker preservation
through iCloud and Google-backed calendars, account switching, invitations,
recovery, larger text and VoiceOver. The signed build-10 installation remains
available while these gates are open.
