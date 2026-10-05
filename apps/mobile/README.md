# Everclose Mobile

The native, offline-first companion to Everclose uses React Native and Expo SDK 57.
It has an independent lockfile so native SDK upgrades do not change the web runtime.

## Development

```bash
npm ci
npm start
npm run validate
```

`validate` runs TypeScript, the mobile unit tests, lint and an iOS JavaScript/Hermes
bundle export. It does **not** build an iOS binary or prove a physical-device journey.
For a native build, run `npm run ios` with the SDK's required Xcode version. Expo 57
requires Xcode 26.4+ and supports iOS 16.4+; this computer currently has Xcode 26.2.
See the [versioned SDK requirements](https://docs.expo.dev/versions/v57.0.0/).
A native build is required to test the registered callback, Keychain behavior and
closed-app notifications reliably; Expo Go alone is insufficient.

The [iOS binary workflow](../../.github/workflows/ios-build.yml) builds native arm64
simulator and device release apps on GitHub using Xcode 26.4.1. The device artifact
can be signed with an existing local Apple identity/profile using
`scripts/sign-development-ios.py`; signing keys stay on the Mac. See the
[personal iOS release record](../../docs/personal-ios-release.md) for artifacts,
installation evidence and remaining physical-device checks.

For committed JS-only corrections, `scripts/refresh-ios-bundle.mjs APP_DIRECTORY
NATIVE_BUILD_COMMIT` can refresh an extracted app under `build/`. It checks that
native dependencies/configuration/modules/assets still match the original binary,
embeds the release Hermes bundle and records its source commits/checksum. Sign
device apps again with the local signer. Native changes require a new Xcode build.

Set `EXPO_PUBLIC_EVERCLOSE_API_URL` to the HTTPS origin of a prepared server, or enter
it in Account & sync. This public variable contains no credential. The default is
`https://everclosecrm.com`. The matching device/sync endpoints and migrations through
0044 are deployed there as of 4 October 2026. Use the matching version-4 cloud service
for saved Calendar context. Sign in and approve this phone to download your existing workspace.
The native client uses version 4 for contacts, interaction history, reminders,
plans, family entries, relationships and read-only saved Calendar events. Schema 12
adds the event cache and requires a complete staged bootstrap before incremental sync.
Frozen version-1/version-2/version-3 requests retain their original body, endpoint and order.
The hosted web service has real Google sign-in. Debug builds accept HTTP
loopback origins for simulator development; localhost on a physical phone refers
to that phone, so use a properly configured HTTPS server for physical-device testing.

## Accounts and storage

Account & sync opens the system authentication browser. After signing into the web
service with Google, the owner explicitly approves the phone. A fixed `bonds://auth`
callback, PKCE and state bind the returned code to the initiating app. The app saves
its generated credential and pending exchange in Keychain-backed SecureStore before
network requests. The server stores only credential/code hashes. Phone sessions
expire after 30 days and can be revoked from web Settings → Connected phones.

Each server/user/workspace combination has a separate SQLite database. Renewable
phone credentials do not change its cache identity. The database also verifies its
account binding. Earlier local-only data stays in its original database and becomes
available again after disconnect; it is not silently uploaded to a signed-in account.
An explicit local-only import/review flow remains planned.

Disconnect removes local credentials and scheduled notifications, while retaining
the account's offline cache. When the network is unavailable, revoke the phone on the
website as well. App files remain protected by the iOS sandbox and device data
protection; SQLCipher and portable native recovery remain public-release work.
The build-6 source candidate adds an optional device authentication gate in Account
& sync, with default-off device-wide policy and authenticated recovery. It is not
in signed build 5 yet. See [native device lock](../../docs/native-app-lock.md) for
validation, privacy limits and remaining native/physical checks. Keeping an offline
cache is distinct from deleting the account or its data.

## Workspace sync

The development client stages all six entities before publishing a complete bootstrap,
with contacts before their dependent records. It
then pulls changes and saves each page with its cursor in one SQLite transaction.
Phone captures use the same UUID on the web. Each outgoing operation is frozen to
an exact persisted request before sending; interrupted responses retry that request.
The contact editor captures its opening values and revision, saves only changed fields,
and retains those original bases even when a web update arrives while the form is open.
Web changes merge around pending fields, while overlapping edits preserve a phone
draft for review. A restored or erased cloud dataset holds old edits for review
instead of resubmitting them into the replacement dataset. An explicitly reviewed
removed draft can be copied to new person and child UUIDs with its pending items.
Child conflicts also have an explicit review; every missing connected person must
be reviewed before a dependent draft can be uploaded. Legacy web history displays
its civil date without inventing an activity timestamp.

Agenda shows open CRM plans in 50-row pages. Each profile opens paginated plans,
family and shared relationships, with creation, editing and removal. Profile selectors
search name, email and phone and show people rather than UUIDs. Forms retain opening
edit bases and guard unsaved changes. Plan completion requires confirming that it
happened and creates one provisional local history record, correlated to the server
by its operation UUID. Cloud races require review; choosing cloud clears unconfirmed
history. Explicit copies after restore use fresh identities. Historical completed-plan
copies preserve metadata without logging another activity. External calendar events
are not connected yet.

Sync runs while the app is active, at startup/resume, after local writes, every
30 seconds, or from Account & sync. It does not promise background or closed-app sync.
Contact scalar data is stored in the replica; current profile screens expose a
subset. Schema 5 retains merged identities, resolves old profile links and reparents
pending associations without rewriting frozen requests. Overlaps and collapsed connections
remain reviewable. Schema 6 adds multiple labeled email, phone and profile methods,
preferred values and original legacy values. The method editor retains its opening
base; overlaps require review without dropping methods added elsewhere. Private cloud
recovery preserves method IDs. CSV/vCard transfers preserve editable method metadata,
while transferred values are treated as user supplied. Schema 7 adds a read-only source
cache. LinkedIn links and user-supplied details created on the web remain available
offline, and older responses cannot erase them. Source editing runs on the web.
Reviewed LinkedIn exports additionally retain email, position and connection-date
context in the existing source projection. Matching native/web builds are required:
earlier strict four-field prototype readers can reject these additional facts.
[LinkedIn import compatibility](../../docs/linkedin-import.md) records the release gate.

Schema 8 additionally caches Google source identity, original observations and
accepted-field details. Its upgrade clears the incremental cursor while retaining
queued edits, forcing a complete current download. Saved Google details remain
available offline; older receipts preserve them and unlink downloads remove only
the source collection. Hosted contact photos now have a separate authenticated
download and an account-local cache. Opening a profile downloads its current JPEG,
PNG or WebP image; People displays already cached photos. Up to 64 recent photos
remain available offline, with initials as the fallback. Downloads verify size,
signature, digest, contact revision and dataset epoch before committing. Restore
purges older photo cache entries; failed or stale downloads never edit CRM fields.
Native photo selection/upload and broader editing remain planned.

Schema 10 retains selected iPhone review previews and device-local source details,
adds a shared source projection and resets the cloud cursor for a complete download
without changing frozen outbox requests. People and profiles can
choose one system contact, review possible matches, create a person or attach selected
name/email/phone fields to an existing one. Matching never silently selects a person.
Review preserves private history, existing methods and preferred choices; original
observations stay immutable. Exact retries resolve the saved person, including after a
merge, and never recreate an unlinked source or deleted relationship. Concurrent edits,
changed source revisions and a known restore epoch require fresh review. Unsaved reviews
expire after a day; source collections stop at 32 links or 128 KiB per person.

Chosen contact fields sync through the ordinary contact outbox. Signing in lets the
review explicitly share original/observed source details, including fields not copied
to the person. A separate durable source queue publishes only after contact changes
are acknowledged. Shared details reach web and other phones and join cloud recovery;
CSV/vCard exports continue to contain accepted CRM fields. Older local sources are not
automatically uploaded. Their first sharing requires another selected-contact review.
An installation UUID in device-only SecureStore scopes raw Contacts IDs; credentials
can renew without changing that identity. Other phones display shared observations
without creating local OS links. Unknown replies retain their exact request; stale
revisions and restore epochs require review. Unlink preserves accepted contact fields
and private history.

Schema 11 adds phone-local reading consent and field choices without clearing the
cloud cursor or changing frozen requests. Reading starts disabled and fields default
to keeping the Everclose value. You can browse allowed Contacts in 50-row pages and
review a selected person through the same create/attach flow. Directory selection
checks current permission and rereads the chosen entry before starting review.
Consented linked entries are checked while the app is in use, after pending sync can
settle, at most hourly unless checked manually, with 20 reads per run. Recurring reads
never request broader permission or import other people. Stable OS field IDs identify
approved methods; ambiguous or missing fields are held. CRM corrections remain sticky
until explicitly reset. Labels, preferred methods and private history stay intact.
Permission loss or a failed read retains saved data and shows a status on this phone.
Merge and restore pause reading for review; another phone receives shared observations
without inheriting permission or field choices. Cloud-visible permission status,
background execution, optional write-back and physical-device testing remain required.
People uses searchable 50-row pages with a sentinel, pull-to-refresh and read
error recovery. Reminder selection uses the paged person picker. Profile timelines
read 20-entry pages using a stable date/time/identity cursor, show original notes,
and offer retry without losing already loaded history. Physical-device usability
testing remains required.

New-person and contact-detail edit forms keep unfinished fields in the current
account's local database, including invalid or incomplete input. Reopening a form
resumes its saved draft. Closing flushes pending writes; explicit discard removes
only that form. Successful save clears it in the same transaction as the person
and outbox change. The original edit base is retained across restart and cloud
edits, including merges, so sync compares the actual original fields. Drafts do
not enter the sync outbox before Save.

Plan, family, relationship and reminder-creation forms also resume local drafts.
Closing or navigating back waits for queued writes; explicit discard removes only
that form. Context edits retain exact original fields/revisions. A resumed reminder
keeps its selected absolute time and timezone; an expired time needs a new choice.
The reminder and outbox commit before notification permission/scheduling begins,
so a scheduling failure reports a saved reminder rather than creating it again.
Alert identities include account, reminder and date. Scheduling, account refresh
and cancellation are ordered to prevent a late response undoing a newer alert.
Actual permission and closed-app delivery checks on the phone remain required.

## Native capabilities and verification

The system contact picker stages one explicitly selected person for review. Expo 57's
picker returns an ID, so field reads still need Contacts permission. The app checks that
permission, requests it only from the explicit picker action, handles denied or limited
access, and offers separate limited-access management. It reads name, email and phone
fields only; it does not scan the address book or request notes, photos or addresses.
No contact fields are saved until confirmation, and no iPhone contact is modified.
This remains selected capture rather than ongoing address-book synchronization. Local reminders use generic
lock-screen text and account-scoped navigation. Switching accounts cancels scheduled
and delivered app notifications, then reschedules the nearest 48 future reminders
without prompting for permission at startup. Incoming reminder changes refresh those
schedules; a same-account refresh preserves delivered alerts and cancels obsolete
or late scheduling results. Notification limits, timezone behavior
and closed-app delivery still require real iPhone testing.

Generated `ios` and `android` projects remain uncommitted; Expo configuration is the
source of truth. Existing bundle identifiers, database filename and callback scheme
retain their earlier Bonds names for compatibility, while the display name is Everclose.

Root tests exercise the actual native data code against SQLite and disposable cloud
handlers, including response loss/restart, paginated downloads, overlap, account
switches, restore, erasure and reviewed copying. Native sign-in, physical phones,
TestFlight, accessibility and provider connections remain release gates until
exercised on the compiled app.
See [architecture](docs/architecture.md), [sync protocol](../../docs/contact-sync.md)
and the [complete development plan](../../docs/product-development-plan.md).

## Saved Calendar context

Agenda combines open CRM plans and reviewed saved meetings in bounded date-ordered pages.
Person profiles show up to three meeting cards and link to a 50-row paginated directory;
filters include explicit person links and the current owner of linked plans. One event
can involve several people without copying its source facts into each profile. Details
include all-day civil dates, timed source zones/offsets, cancellation, source status and
last observation time. Removed context disappears through a tombstone or a complete
bootstrap; restore replaces the cache under a new epoch. Interrupted downloads or local
transaction failures preserve the previous visible cache and offline CRM edits.

Meeting details are available offline after synchronization. Review people and plan links
opens a native editor with searchable 50-row pages, persistent off-page selections and
an explicit save of up to 20 people and 20 plans. Create a person and return to link them,
or attach an existing plan. Unavailable/merged targets must be reviewed; a plan already
linked or queued elsewhere cannot be taken implicitly. Save commits a durable phone
intent before sync, with pending/review labels in agenda and profile cards. Provider
consent still opens the web. Reading or linking a meeting does not complete
a plan, log an interaction, publish an event or request iPhone Calendar permissions.
Unified web agenda/profile cards and native association editing have local implementations.
Google recurring event jobs and reviewed plan publishing now have local implementations.
The Apple Calendar bridge also has a local implementation described below. Bundle export is verified separately
from a native binary, physical-device rendering, Google OAuth and TestFlight.

Phone schema 13 adds a separate link-only outbox without widening the six-entity outbox
or read-only version-4 event contract. Existing schema-12 cache, cursor and core drafts
survive upgrade. Only selected UUIDs and the reviewed semantic digest are queued; source
facts are not duplicated. New people/plans upload first. An uncertain request keeps its
exact operation/body and locks further editing/discard until confirmed or definitively
held for review. Source/graph changes, removed targets and restored epochs keep choices
for explicit review or discard, without recreating a removed meeting. Sync review can
open a held intent even when its event is gone. A failed local acknowledgement retains
the request; an older acknowledged projection cannot regress newly redacted context.

## Plans in Apple Calendar

The iOS Agenda and person Plans cards open a reviewed system event editor. Creation,
optional full-access verification and default-off date following are separate actions.
Durable schema-14 receipts prevent a lost creation reply from opening another create;
marker searches can reconcile moved/unknown IDs. Date following queues only an ordinary
plan-date patch, preserving notes, completion and history. Manual date corrections are
sticky, and recovery/account/source changes require review. Event facts and receipts
stay on the choosing phone; their shared/cloud representation and cross-provider
reservation are still required. [Apple Calendar runbook](../../docs/apple-calendar.md)
describes permissions, bounds, recovery and remaining validation.

`modules/everclose-calendar-facts` is an autolinked Apple-only Expo module for minimal
EventKit facts with actual timezone identifiers. Its Swift source must be compiled into
a development or distribution build; Expo Go and Hermes export cannot validate it.
Physical editor behavior, Calendar synchronization and all-day/clock-change boundaries
remain open. Upgrade 13 to 14 preserves existing data, queues, source links and cursors.

### Installed personal build 4

The photo-picker build 2 was withdrawn after a precompiled framework mismatch.
Build 4 is signed and installed. It compiles iOS modules from matching sources;
both Release builds, linkage verification and isolated SQLite/Keychain startup
pass in run 37278926485. It also recovers database/account startup errors without
resetting saved data. After the owner unlocked the phone, physical launch and
process-stability checks passed. Confirmation of the UI and contacts is pending.
Open a person and choose **Edit contact photo** to
select a photo, preview the small copy, and explicitly save or remove it. Drafts
and queued images remain on the phone offline. Unconfirmed requests retry
unchanged; a changed cloud photo requires review. The API is deployed, all 820
root tests pass, and the 15 complete photo journeys pass against disposable D1.
The compiled manifest includes the photo explanation and no camera/microphone
usage keys. See the personal iOS release record for exact binary/hash evidence
and remaining physical-device and TestFlight checks. The exact current package
and source are recorded in [the build-4 release record](../../docs/personal-ios-build4.md).

### Gmail integration status

Gmail downloads and reviewed correspondence matching now have a tested cloud/web
implementation, including existing and later-created people, shared addresses,
exclusions and separate per-person metadata. Local D1 is at migration 47; these
changes are not deployed to production or included in personal iOS build 4.
Native schema 15 now implements a separate read-only Gmail protocol, default-off
offline metadata storage, per-person cards, bounded paging and cache invalidation
for account/consent/identity/recovery changes. Frozen version-4 requests remain
unchanged. This source is not in the installed schema-14 build 4; a matching
server deployment/native release and the real-account pilot remain required.
The build-5 candidate passes all 868 root tests, 15 D1/mobile SQLite transport
checks, native TypeScript/lint, five package tests and production Hermes export.
Both native Release builds, linkage and isolated simulator SQLite/Keychain startup
pass in run 37306709947. Build 5 is signed and verified; installation awaits
iPhone reconnection/unlock. Follow [the build-5 record](../../docs/personal-ios-build5.md)
for exact package/source and delivery evidence.
Recurring jobs and reviewed activity behavior are also unfinished.
See [Gmail implementation](../../docs/gmail.md).
