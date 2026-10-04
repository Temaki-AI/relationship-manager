# Mobile architecture

Everclose Mobile is offline-first. Capture, local interaction history and reminders
work without an account or network. The Next.js/Cloudflare application supplies the
shared cloud service; the native app is not a web view wrapper.

## Identity and accounts

Contacts use UUID primary keys shared with the cloud public IDs. Nullable integer
`remote_id` values are compatibility references, not cross-device identity. Local
interaction/reminder UUIDs are shared with their cloud public IDs; parent references
in the transport use the person's UUID.

The account cache key includes normalized server origin, workspace ID and user ID,
with an independently checked SQLite ownership row. Tokens stay in Keychain-backed
SecureStore and are excluded from SQLite and CRM snapshots. A renewed device session
continues the same account cache. Local-only data has a separate legacy database.

Native authorization uses the system browser, explicit approval in the user's web
session, PKCE, state and a fixed registered return scheme. The app persists its random
credential before exchange; the server hashes it and grants only supported sync and
self-session inspection/revocation. Management of other devices requires web auth.
Google login does not authorize Contacts, Gmail or Calendar data access.

## Storage and reconciliation

Expo SQLite migrations are monotonic and transactional, guarded by `user_version`.
Foreign keys, WAL mode and a busy timeout are enabled. Migration 2 preserves existing
rows and adds original edit bases, frozen requests, epoch binding, conflict state,
the last cloud projection and bootstrap staging. Migration 3 adds child replicas and
mixed-entity staging, preserving civil interaction dates independently of optional
exact timestamps. Existing frozen requests remain unchanged; only proven legacy
completion bases are recovered. Migration 4 adds plans, family and relationships,
provisional history linked to a plan, and a six-entity outbox. The rebuilt outbox retains
row order, frozen request bodies and retry/review state. Queries bind user values.

A complete bootstrap is committed from staging with its cursor in one transaction.
Partial downloads leave the old replica visible. Incoming pages overlay fields with
pending changes and retain tombstones without cascading away local history. Push
acknowledgements remove only the matching frozen intent; an older receipt cannot
replace a newer downloaded projection. Operations for each entity run in queue order;
children wait for every referenced person to reach the cloud, while frozen requests
may still resolve their exact receipt after a referenced person is deleted.

Restoration rotates the server epoch. Old intents become review items; they are never
silently rebound to the new epoch. Review may adopt cloud values, send reviewed phone
fields against the current cloud base, or explicitly copy a removed draft to fresh
person and child UUIDs with pending history/reminders. Child reviews retain their
original fields and require a current parent before submitting or copying a draft.
Reviews reject changed input and do not run alongside a transport operation.
Auth expiration and network failures preserve the outbox.

The six writable entities and read-only saved Calendar context use version-4 sync. Older frozen version-1/version-2/version-3 requests still
replay through their original endpoints. Plan completion writes one provisional history
row under its operation UUID; the server publishes that same history identity. An
already-completed cloud plan cannot be completed again by choosing phone during review.
Fresh completion copies/reviews use new operation/history UUIDs. Historical completed
metadata copied via create does not log another activity. Web history
without an exact time remains date-only in the phone UI. Schema 5 rebuilds merge aliases
from complete downloads, resolves old links and reparents associations while retaining
original request bodies. Overlaps compare against the survivor; collapsed connections
require review. Schema 6 adds stable contact-method IDs, preferred values and original
legacy values. A method form retains its opening collection; remote changes overlay
around unrelated pending fields, and overlapping collections require explicit review.
Review applies the original draft's changes to the current methods without dropping
new methods added on the web or inherited through a merge. Schema 7 caches the
read-only source projection. Web LinkedIn links and reviewed source details are visible
offline; absent metadata in older receipts retains the current source collection, while
an explicit empty collection removes it.

Schema 8 separately caches read-only Google `provider_links`, with provider identity,
original/observed facts and accepted-field audit data. Its upgrade refreshes the full
cloud projection while retaining the outbox. It preserves metadata missing from older
acknowledgements and accepts explicit removal. Source editing and Google authorization
run on the web. Photos and local-only migration remain planned. Pull and bootstrap use bounded pages, although the final SQLite bootstrap transaction can be
large; measure real-device dataset limits before release. People currently displays
at most 500 rows and still needs proper pagination. Agenda and context lists use
50-row pages; editors and the person picker support plans, family and both relationship labels.

Schema 10 introduced immutable selected iPhone observations and local source links.
The native reader checks permission before reading only name/email/phone fields for the
chosen contact. Limited-access management does not import people. Review confirms identity
and fields; accepted contact changes and their source receipt share a local transaction.
Person/source revision checks, known restore epochs, bounded payloads and exact retries
protect existing data. Merges reparent local sources without rewriting frozen operations.
Selected fields travel through ordinary contact intents. Explicit source sharing adds a
separate durable queue after those intents are acknowledged. Installation-scoped source
UUIDs and revision/epoch fences protect cloud publication, exact retries and unlink.
Shared facts join recovery and appear in a read-only contact projection. The choosing
installation can hydrate its OS links; other phones only display the observations.
Distinct private local links survive cloud identity collisions for explicit review.
Older local facts never upload automatically. A raw iPhone record ID does not identify
the same person across phones.

Schema 11 adds `device_contact_policies` for consent, per-field baselines, sticky
overrides and local read status. Consent stays on the choosing phone, starts disabled
and is not granted by cloud hydration. A field follows only one local device source.
Contact-edit triggers preserve corrections even if later reverted; source reassignment
disables policies after a merge. Bootstrap suspends old-epoch choices after restore.
Policy/source revisions, account scope, installation identity, epoch and active
generation fence delayed reads. Pending person/source intents settle before another
observation can apply. Accepted fields, updated observations, policy baselines and both
outboxes commit in one local transaction; cloud writes retain their existing separate
acknowledgement boundaries.

Foreground reconciliation checks at most 20 consented links per run, with hourly
rotation and explicit Check now. It never expands OS permission or creates people.
The directory requests only names/emails/phones in 50-row pages with one lookahead;
choosing a row rereads that identity and enters explicit field/identity review.
Permission changes, inaccessible limited entries and uncertain ContactStore errors
preserve people and source facts. Read status remains phone-local; cloud status,
background scheduling and physical iOS permission journeys are still required.

## Lifecycle and notifications

Foreground startup/resume, a 30-second timer, local writes and manual action trigger
sync. An account change invalidates network results before local commit. Background
sync and server push are separate milestones.

Notifications contain generic lock-screen text and an account scope. A previous
account's notification cannot open a profile in the new account. Switching accounts
cancels all app schedules/delivered alerts and rebuilds the nearest 48 future reminders
without requesting permission on startup. Same-account reminder changes refresh
schedules while preserving delivered alerts. Scheduling that finishes after an
account or desired-schedule change is cancelled. Real closed-app delivery remains
unverified.

## Package isolation and release evidence

Mobile dependencies have their own lockfile and React Native dependency tree. Metro
watches the repository for shared pure domain code, excludes generated web output and
root dependencies, and resolves packages from the native installation. Expo 57's
on-demand filesystem could not resolve the sibling domain files in this isolated
layout; the standard watched filesystem is configured and bundle export passes.

The server and native data code pass SQLite and disposable Worker/D1/R2 tests. A
successful Hermes bundle export does not prove OAuth, native linking, Keychain behavior,
notification delivery, native compilation or TestFlight. Expo 57 requires Xcode 26.4+
while the installed toolchain is 26.2. Live OAuth/staging/device journeys and the full
product plan remain open, including local-only import, SQLCipher/recovery, app lock,
provider access and public distribution.

## Saved Calendar replica

Schema 12 stores one strict version-4 `source_event` record per canonical event UUID,
with a display-order anchor and its sync revision. All-day anchors are for sorting only;
UI dates remain civil dates and do not become notification instants. Timed endpoints
retain their source timezone and offset, including repeated DST hours. Source facts and
linked person/plan UUIDs are server-authored; this table has no writable outbox type.
Associations are read from current local people/plans, with merge aliases resolved and
missing targets represented or omitted explicitly. Private CRM notes are never copied
into source facts. Source observation time and access status are distinct from freshness.

The version-4 cursor starts empty on upgrade because an earlier cursor skipped events.
A complete bootstrap stages all seven entities, clears/rebuilds the event cache and
commits it with the cursor in the existing exclusive transaction. Partial download and
failed local writes retain the old visible replica and pending edits. Old cursors remain
as epoch evidence; mirrored compatibility cursors continue supporting the existing
device-source/review helpers. Incremental source tombstones remove only saved context.
Restore rotates the epoch, rebuilds the cache and preserves old local intents for review.
Account cache isolation and the account-current checks apply to event transport too.

Agenda mixes open plans and saved events in bounded pages. Profile cards fetch only three
events, while the full directory uses 50 plus a next-page sentinel. Person/plan names are
resolved through bounded JSON joins, rather than one SQL call per participant. Meeting
source facts remain read-only on phone. Schema 13 adds a separate association outbox,
native editor and sync review, using the exact version-1 link API with public IDs and
a SHA-256 digest of the reviewed version-4 source record. It never queues another copy
of source facts. Upgrade from schema 12 preserves its event cache/cursor and core drafts.
Queued choices overlay local agenda/profile links; facts and access still use the latest
canonical cache. Six-entity writes upload before association operations, and frozen
unconfirmed bodies bypass missing-target checks so their receipt can be reconciled.
Acknowledgement projection and intent removal share an exclusive transaction; failures
retain the exact request. Monotonic event revisions prevent an old reply from undoing
privacy redaction. A restored epoch holds old choices atomically with bootstrap publication.
Only definite conflicts can be replaced after explicit review or discarded; an unknown
pending response stays locked. Provider consent/publishing and actual native/device
evidence remain separate requirements.

Schema 14 adds phone-local Apple Calendar receipts, independent of the canonical
version-4 event cache and association queue. An immutable draft/marker and monotonic
attempt flag are stored before the system editor; creation has no automatic retry.
Saved/unknown results require exact-marker verification. Observed EventKit IDs can move,
so rebinding requires explicit review. Account/recovery guards fence asynchronous replies;
receipts survive plan removal. A date-following observation updates the receipt, plan
date and original-base outbox intent in one transaction. The plan-date trigger suspends
following for every other date change, including one later changed back. Reads default
off, are bounded/throttled on foreground sync and never prompt in the background.

The Apple-only `EvercloseCalendarFacts` local Expo module exports minimal EventKit facts
with `TimeZone.identifier`, avoiding localized SDK timezone abbreviations and unnecessary
notes/attendee projection. Editor presentation uses `expo-calendar/legacy`, which is
supported in SDK 57; root deprecated Async calls throw. Creation on iOS 17+ does not ask
for broad read access; iOS 16 needs permission before editor presentation. Explicit
verification/editing require full access. This needs a real native build and device
checks; JavaScript export does not compile or run the Swift bridge. The cloud still sees
ordinary plan-date changes only. Cloud source sharing, concurrent web/phone reservations
and reconciliation of Google/EventKit copies remain engineering gates. See the
[Apple Calendar runbook](../../../docs/apple-calendar.md).
