# Google Calendar connections, choices and event downloads

This is the authorization, calendar-selection and staged event-download foundation for the full
[product plan](product-development-plan.md). It is implemented and verified locally.
Reviewed people/plan links and canonical event recovery are implemented on web. The cloud and development iPhone
client now transport saved event context through version 4, with offline agenda/person
cards. Unified web cards, the native link-only API, phone editor and durable association
outbox, opt-in recurring event jobs and optional dedicated-calendar setup are implemented locally.
Native binary/device validation, complete plan publishing and the Apple calendar bridge
remain required work. Real Google
authorization has not been verified and nothing has been deployed.

## Setup and consent

Create a dedicated Google Calendar OAuth web client, distinct from both Everclose
sign-in and the Contacts connector. Enable Calendar API in its project and configure
the consent audience/test users. Set `GOOGLE_CALENDAR_CLIENT_ID` and
`GOOGLE_CALENDAR_CLIENT_SECRET` on the server. Reuse the server's existing versioned
`CONNECTOR_TOKEN_KEYRING`; credentials remain encrypted and bound to their own grant.

The callback is `/api/connections/google/callback` on the configured Everclose origin.
For this computer it is `http://localhost:3100/api/connections/google/callback`.
Register the exact development/staging/production callbacks only on the corresponding
clients. The Google sign-in callback is separate. Keep secrets in the ignored local
environment or the hosting secret store, rather than repository files or browser code.

Calendar requests basic verified account identity and these read-only scopes:

- `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
- `https://www.googleapis.com/auth/calendar.events.readonly`

It does not request event/calendar write scopes or Gmail access. Google describes these
permissions in its [Calendar scope reference](https://developers.google.com/workspace/calendar/api/auth).

Migration 38 adds a resource purpose to each connection and authorization attempt.
Existing records retain `contacts`; Calendar uses `calendar`. A Google subject may
therefore have separate Contacts and Calendar grants without replacing either record.
Reauthorization must return the original subject and resource. State, PKCE, owner,
workspace, epoch and revision fences apply to both resources. Refreshes use the resource's
configured client, retain its exact scope boundary and serialize through the existing
lease. There is still a ten-record limit across all resource grants, including disconnected
ones; it is not a ten-account-per-resource allowance.

Separate client IDs do not prove independent revocation. Google documents that token
revocation can invalidate all clients in the same Cloud project. Use separate projects
when independent sign-in/Contacts/Calendar revocation is required. The disconnect dialog
reports the shared-project consequence, and another invalidated grant requires
reconnection on subsequent use while preserving CRM people and history.
[Google token revocation](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke).

## Discover and choose calendars

Open Data connections → Manage Google Calendar, connect an account, then Review calendars.
Discover calendars starts a durable run; Continue discovery advances one provider page.
No calendars are selected automatically. Discovery reads only list
metadata: opaque ID, displayed name, timezone, access role, primary and hidden flags.
It excludes calendar descriptions and does not read event payloads at this stage.

Each step receives at most 50 calendars and 512 KiB of response data. Discovery stops at
500 calendars or 20 pages. Pages stage in a new generation; only a complete valid result
publishes the list. Empty pages with a next token still require continuation. Invalid
metadata, duplicate identities, immediately repeated cursors, oversized lists and exhausted retries
keep the last complete list. Quota errors retain authorization and a durable retry deadline.
Explicit scope loss stops the grant and clears operational choices for renewed consent.
[Google calendar-list API](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list).

Search and review use 50-row pages bound to a published generation. Saved choices also
appear separately so a selected calendar outside the current page remains visible.
Confirm up to 20 available calendars with event read access. Previously selected missing
or restricted calendars can be kept or removed; they are not evidence that a relationship
or person should be deleted. Choices are limited by the 32-KiB request bound.

Selection uses the opening generation, selection revision, authorization revision and
dataset epoch. A durable receipt commits with the new choice. Concurrent or exact retries
have one effect; changing choices cannot reuse the operation ID. An uncertain browser
response pauses editing and offers the frozen request again. Tab session storage can
recover that request after reload, scoped by connection and the verified dataset epoch.
Closing the tab can clear that storage. A later replay acknowledges the original choice
without undoing newer confirmed choices; refresh shows current settings.

## Read events from a saved calendar

Open **Review events in …** under Saved calendar choices. Choose past and future days,
confirm the download, then advance it with **Continue event download**. Defaults are
90 past days and 180 future days, plus today; the combined past/future bound is 365 days.
The run fixes its UTC window using civil-day boundaries in that calendar's timezone,
including DST. A run reads at most 50 events per page, 2 MiB per response, 5,000 records
and 200 pages. A too-large result fails visibly and retains the last complete view.
Cancel a pending download to discard its unpublished pages and choose another window.
Completed downloads are not undone by a late cancellation.

Pages stage in a separate generation and publish atomically only on completion. Fixed
window, authorization/selection revisions, epoch, owner, lease and base-generation checks
fence late results. Next-page hashes detect immediately repeated and longer cursor loops;
duplicate event IDs and unsupported details fail without replacing the complete index.
Transient errors persist a retry deadline, bounded to 2–900 seconds, with at most nine
consecutive failed attempts. Calendar-specific 403/404 failures mark the resource unavailable
and retain its prior complete index without revoking the account. Explicit scope loss
requires reconnecting the grant. Selecting a calendar does not automatically start a run.

The provider request expands recurring occurrences and includes explicit cancellations.
Source identity remains account + calendar + event ID; recurring series ID, original
occurrence time and iCalUID remain separate evidence. Copies in two calendars are not
automatically merged. Offset timestamps retain their original zone and UTC instant;
all-day dates retain their exclusive end date. Valid wall time with an IANA zone is
resolved only when its offset is unambiguous; a DST fold retains the supplied wall time
without inventing an instant. Cancelled events can contain only an ID, or a series ID
and original occurrence time. They are hidden from the ordinary view and can be included
explicitly for review. Their presence never logs a completed interaction.

Private/confidential events are redacted **before persistence** to busy time: no copied
title, location, organizer, attendees, iCalUID or event/conference URLs. Ordinary event
facts retain bounded title/location, dates, participant responses, organizer, provider
version and safe HTTPS event/video links. Descriptions, attachments, participant comments,
conference passwords and access codes are neither requested nor saved. Google can return
only a partial participant list when it exceeds the requested 100-person limit; that
status is retained and displayed. Event rows stop at 64 KiB.

Web review uses generation-bound 50-row pages and shows the chosen window, last complete
download, unavailable state and retry progress. Unknown starts retain their exact operation
ID and request in tab storage, scoped by connection, calendar and verified epoch; retry
does not change the dates or create a second run. Starting, continuing and cancelling are
owner-only, origin-checked operations at `/api/connections/<uuid>/calendars/events` and
its `/step` route. Manual downloads remain independent of the opt-in recurring schedule
described below. Reads never write to Google, invite people, create CRM people or log history.

Google forbids combining incremental sync tokens with the date filters used here.
This implementation is a bounded full-window source index, not an incremental replica.
Changing a window or observing an absent event is not proof that a source event was
cancelled. [Events list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)
and [event identity, dates and cancellations](https://developers.google.com/workspace/calendar/api/v3/reference/events).

## Automatic downloads and rolling windows

The selected-calendar events page offers an explicit **Keep this calendar updated** choice,
off by default even after consent, selection or a manual download. Choose daily or hourly
and the past/future days before confirming. Enabling is available before the first download.
The combined bound stays 365 days plus today, with 5,000 events and 200 pages per complete
download. The next eligible time is shown separately from the last complete observation.
Cron checks every 15 minutes; eligible time does not guarantee immediate delivery.

Each new run calculates the calendar's current civil-day window, including DST, and
captures its dates and timezone for every page. It performs a complete bounded read,
without an incremental sync token. Expanding the recurring window confirms a new full
backfill within the same limits; a manual download can temporarily review a different
bounded window. Neither route silently expands consent or creates links to attendees.
Events absent within a complete overlapping window become unavailable rather than
inventing cancellations. Events outside the new window retain their reviewed links and
facts with the existing freshness rules. Private detail redaction still precedes storage;
private notes, plan dates and confirmed history are never replaced by event observations.

The operational resource stores cadence, window choices, settings revision and next eligible
time. Run creation advances that time atomically, so duplicate Cron ticks cannot create two
active downloads for one calendar. The `google-calendar` queue message carries only workspace,
connection and run identifiers. A durable page checkpoint commits before enqueueing the next
message; a send outage is repaired by Cron. Provider retry deadlines and eight retry failures
remain bounded. Duplicate deliveries share the existing 45-second run lease. Reconciliation
dispatches at most five runs per tick, rotates successful dispatch order, expires unleased
abandoned scheduled runs after 24 hours and collects unpublished stages in bounded batches.

Changing or disabling a schedule cancels unfinished scheduled reads and removes their
stages, while preserving manual reads and the previous complete view. Schedule revision,
selected-calendar revision, owner membership, current epoch, authorization and grant expiry
are checked again before publication. Calendar rediscovery or changed selections cancel
unfinished reads. Calendars that remain selected retain their explicit schedule and next
eligible time; deselecting a calendar removes its schedule. Reauthorization, disconnect
and dataset maintenance/recovery clear schedules: opt in again after reviewing access.
Schedules and queue work stay outside CRM backups and phone sync.
Their resulting canonical event observations reach the existing version-4 phone service.

`PATCH /api/connections/<uuid>/calendars/events/schedule` is owner-only and origin-checked.
It requires the current epoch, authorization, selection and settings revisions. Unknown
saves retry the unchanged request; a refreshed authoritative settings revision resolves
the result without repeating a consent change. Current active work takes priority in the
review; equal timestamps use insertion order instead of random UUID ordering.

Deployment requires migration 42 and `GOOGLE_CALENDAR_QUEUE`, configured in both Wrangler
files. Provision `everclose-google-calendar` and `everclose-google-calendar-failed` before a
production rollout; the local equivalents use `everclose-local-google-calendar` names.
The bindings are checked in, but no production queue creation, migration or deployment is
implied. Next dev does not execute Cron automatically. Disposable Worker tests simulate
Google responses and queue sends; actual Google consent, service delivery, quota behavior
and the owner's unattended refresh remain release checks.

## Recovery, access and remaining work

Only the current web-authenticated owner manages authorization, discovery, choices and events.
Device grants cannot manage provider permissions. Provider credentials, calendar lists,
choices, event indexes, runs, publishing setup and provider receipts stay outside portable/private CRM
recovery and phone sync. Saved event facts and reviewed people/plan associations are
canonical CRM data included in schema-14 recovery; older backups remain readable.
Their web mutation receipts remain operational. Phone transport and offline context are implemented locally; real-device evidence is pending. Disconnect, reauthorization, permission
loss, maintenance and restore fence old results and clear operational read choices. Publishing
setup retains its attempted marker and any known calendar ID for explicit repair, as described below. Workspace
erasure cascades through these records. Restoring never rolls back Google calendars.

Apply migrations `0038_google_calendar_resources.sql`, `0039_google_calendar_events.sql`, `0040_calendar_event_links.sql`, `0041_calendar_event_sync.sql`, `0042_calendar_event_schedules.sql` and `0043_owned_calendar_setup.sql`
with the matching application before using these routes. The journal/snapshot chain and
disposable SQLite/Worker migrations are verified; only isolated local D1 has received them.
Readiness now requires 0043. These bounds do not establish live
Google quotas or public-scale performance.

Validate the implemented web and native association editor/cache/cards with actual accounts and on a device.
Preserve relationships and reviewed links when a source is missing, revoked or outside a
new window. Validate the locally implemented consented recurring jobs and rolling-window
repair. Dedicated-calendar setup now retains uncertain creates for verification; reviewed
plan-to-event publishing and updates remain to be implemented.
[Incremental sync](https://developers.google.com/workspace/calendar/api/guides/sync).

Actual-account consent, revocation, source changes, supported native builds, staging
migration/recovery and the eventual end-to-end calendar journeys remain release gates.

## Reviewed event context and links

The source event review offers **Link to people and plans**. Saving reads the event from the current complete, authorized source generation; the browser submits only reviewed person/plan IDs and expected versions. Account, calendar, event identity, authorization, selection, generation, workspace epoch and current saved revision are fenced in the transaction. Participant email matches include additional contact methods and ambiguous shared addresses, skip the owner's known identities and room/resources, and never select a person automatically. Suggestions show at most five candidates per address; people and plan directories have 50-row search pages.

An event is saved once per workspace, verified Google subject, calendar and source event ID. Separate person and plan links allow a group event to involve multiple relationships without duplicating its source facts. Each event supports up to 20 explicit people and 20 existing plans. A plan can reference one saved event. Provider copies from different accounts/calendars are not automatically merged by iCalUID. Linking a plan never changes its date, notes or completion state, sends invitations, or creates interaction history.

Save an event with no links before creating people, then edit its retained context later. **Calendar → Saved calendar context** lists saved events, and a person's **More contact actions → Calendar context** filters explicit person links plus events associated with that person's current plans. Saved details can be reviewed without a live provider grant; an unavailable/review-required status explains that they may be stale. Reviewed plan ownership follows ordinary plan edits and contact merges. Merging people collapses repeated event/person associations and preserves plan links.

Only a complete published download refreshes saved source observations. Privacy changes redact copied details to busy time while retaining reviewed associations. Cancellations preserve context and never prove an interaction. An event absent from a complete overlapping window is unavailable, not cancelled; one outside a new window retains its previous facts and requires review. Disconnect and restoration retain CRM context, but operational consent and indexes must be re-established. User relationship notes and history remain independent.

Schema-14 interactive and resumable private recovery include events and both link tables, including events with no links. The source adapter validates normalized facts against the same strict reader before persistence, including exact string types for privacy/status/response flags. Malformed source pages preserve the previous complete view. Strict recovery readers validate redaction, safe URLs, occurrence/time semantics, workspace references, source uniqueness and link bounds. Genuine older manifests normalize absent event tables without changing their original part chain. Restore keeps the saved revisions and resumes under a new epoch. Workspace erasure removes canonical context as well as provider operational records.

Web save, edit and removal use atomic receipts and exact request fingerprints. An uncertain response retains the frozen request in tab storage, so reload retries the same operation and choices. Stale event versions keep the choices for review; a changed workspace epoch clears old person/plan draft IDs so they cannot refer to a different restored record. Unexpected service failures retain the frozen request for exact retry. A different body cannot reuse the operation. Removing saved context requires a verified pre-delete CRM backup and removes only the saved event/link graph. People, plans, notes, history and the Google event remain intact. The downloaded source event remains visible and may be saved again; this is not a persistent exclusion. Retained recovery points can still contain removed context.

Web agenda/profile cards, native association editing and recurring jobs also have local implementations. Complete publishing, actual-account consent and physical-device evidence remain required for the personal beta. No production migration or deployment occurred.

## Saved event sync service

Protocol version 4 adds `source_event` to the existing six-entity bootstrap/pull journal.
Each saved event has one immutable public UUID and bounded JSON-string collections of
linked person/plan UUIDs. Source facts, account/calendar labels, observation time and
source availability are included; private CRM notes and provider credentials are not.
Versions 1–3 filter out event records while advancing past their journal entries.
Existing six-entity push operations retain their receipt contract across versions;
`source_event` writes are rejected. Reviewed association writes use the independent link-only API.

Availability describes the source held by an active workspace owner, rather than permission
for each reader to manage that owner's Google connection. Web and version-4 projections use
the same rule. Disconnection, lost membership, deselection and unavailable resources update
the shared journal. Bootstrap/pull also refresh expired-grant observations before reading
its cursor; an expiry during a paginated bootstrap requires a restart. The saved facts and
links remain available for review. The last downloaded time is an observation, not proof
that a provider is still current.

Migration 41 seeds existing canonical events without changing their IDs and publishes
updates/tombstones into the shared journal. This is operational transport state, so CRM
backup schema remains 14. Restore rebuilds event projections while paused under a new
epoch, with source access requiring review; erasure clears canonical and transport state.
The development phone now uses version 4 and schema 13, with complete staged replacement,
transactional cursor commit, exact retries of older requests, offline detail views, mixed
agenda pages, person cards and native association editing. Schema 12 introduced the event
cache; schema 13 preserves that cache/cursor and adds its independent link outbox.
Consented recurring jobs/window repair and dedicated-calendar setup now have local implementations. The next slice completes reviewed plan publishing. Unified web cards and profile previews are described below.

## Native association API foundation

`POST /api/v1/calendar-event-links/push` accepts a current, unrevoked owner device
session. Its exact version-1 JSON contract is `version`, `operationId`, `epoch`,
`eventId`, `baseFingerprint`, `contactIds` and `planIds`. IDs are public UUIDs; each
selection contains at most 20 distinct IDs, and the request is limited to 4 KiB.
Unknown fields, source facts, provider identifiers and integer CRM IDs are rejected.
The SQLite/self-hosted route reports that a Cloudflare account is required.

The shared `calendarLinksFingerprintInput` reader derives a deterministic array from
the saved version-4 record. Both callers hash `JSON.stringify(input)` with SHA-256,
using lowercase hexadecimal. It includes the reviewed meeting's semantic facts,
timezone and existing links. Participant order is normalized. Observation age, source
availability, account/calendar display labels, provider etags/updated timestamps and
transport revisions do not invalidate the review. Changed source details, privacy,
recurrence identity or links require a new explicit review. A phone outbox should retain
only this digest and selected IDs, not another copy of facts that could later be redacted.

The server resolves targets within the workspace without silently substituting a
merged or removed person. A plan cannot be taken from another saved event. The commit
checks current owner/device permission, epoch, recovery pause, canonical event revision
and exact public target identities in the same transaction as the graph and receipt.
Disconnected sources can still have their retained CRM associations edited. Linking
does not change provider events, plan dates, reminders or confirmed interaction history.

Acknowledgements contain exactly `version`, `operationId`, `epoch` and `event`, using
the latest strict version-4 source record. A committed operation is replayed before
rechecking its old review or selected targets, so retries after a privacy update or merge
confirm its receipt and return current context. Removal returns `event: null` without
recreating the meeting. A reused operation ID with another body is rejected. Restoration
rejects the old epoch, and revoked devices cannot confirm or apply edits. Unconfirmed
server failures require retrying the identical operation; definite changes remain for
review. These association writes do not widen the read-only version-4 event push contract.

The native editor and durable queue now use this contract. Cloud migration 42 and canonical
recovery schema 14 are unchanged; phone schema 13 adds only its local association queue.

## Native association editor and offline queue

Open a saved meeting's **Review people and plan links** action on the phone. Source facts
stay read-only. Search people by name/email/phone and plans by summary/person/date, using
50-row pages with a next-page sentinel. Selected items stay visible across searches/pages.
Unavailable or merged identities must be removed/replaced explicitly. Plans linked or
queued elsewhere cannot be selected implicitly. Create a person and return to link them;
new people and plans upload through the existing six-entity service first.

Save commits the selected IDs and reviewed digest to an account-isolated SQLite outbox
before any network request. Pending/held choices overlay links in profile/agenda cards,
while facts, access and observation age always come from the latest canonical cache.
Navigation warns before discarding an unsaved form. A source/graph change requires explicit
review of current context while retaining selections; a merge never silently chooses a
replacement UUID for an unsent intent. Metadata-only observations do not invalidate its digest.

Sync freezes the exact request before sending and advances at most eight association
operations per cycle. An unconfirmed request stays locked against replacement/discard
and retries unchanged after restart, removal or merge. Only a definite conflict permits
a fresh reviewed operation or discard. The current projection and queue removal commit
together; a local write failure retains the request. Older acknowledgements cannot
replace newer privacy redaction. Restored epochs hold earlier choices in the same
transaction that publishes a complete new bootstrap. Sync review reaches held choices
even when their meeting is gone; neither review nor retry recreates removed context.

Schema 12→13 preserves existing cached events, version-4 cursor and core intents without
forcing another bootstrap. Earlier schema upgrades still require the complete event
download introduced in schema 12. The local queue stores no copied source facts, provider
credentials or private notes. Cloud canonical recovery remains schema 14.

Offline/file-restart, receipt, acknowledgement-failure, privacy, removal, restoration,
merge, account-switch and directory-bound journeys have disposable service checks.
Crypto is shimmed in the Node native-data harness; the successful iOS Hermes bundle
export is not a native binary or device/VoiceOver/rendering/OAuth check. The installed
Xcode was rechecked at 26.2, below Expo 57's 26.4+ requirement. These release gates remain
open. [Expo 57 requirements](https://docs.expo.dev/versions/v57.0.0/).


## Unified web Calendar and person context

The cloud Calendar month and agenda now include reviewed saved events alongside CRM
plans, reminders, birthdays and confirmed history. A source-first event needs no person
link. Person filtering includes every explicitly linked person and the current owner
of each linked plan. A many-person meeting stays one source record and one agenda card;
the month grid shows it on every overlapping day. Associations do not become completion
actions or confirmed interactions. Calendar reads preserve the owner access required by
the saved-context directory; other workspace readers retain the existing CRM calendar
without gaining source-management access.

All-day ranges keep their supplied civil dates and exclude the source end date. Timed
ranges use the viewer's days for placement, including midnight-exclusive ends, while
meeting cards display the supplied source zones and offsets. Cancelled occurrences can
use their supplied original date; cancelled cards have no conference action. An
unresolved local time is shown with its supplied zone and an explicit missing-offset
label in retained context, but is never invented as an instant on the calendar. A notice
links to saved context when any meeting cannot be placed reliably.

A range includes up to 100 compact source cards with a separate 512 KiB UTF-8 budget.
Participant lists, operational provider IDs, credentials and CRM notes are omitted from
that projection. Source facts, current plan owners and access observations use one D1
batch snapshot. Truncation is explicit and links to the paginated saved-context view;
local filters apply to downloaded records. Person profiles request three latest saved
contexts and expose the full directory when more exist. Cards show source status and
observation time; neither proves that the provider was checked recently. The shared
date display also serves the phone.

Native link editing, recurring event jobs and window/backfill repair now have local implementations.
Complete plan publishing, the Apple calendar bridge, real authorization and supported-device validation remain
required. No cloud migration, phone schema or CRM backup-schema change was introduced
by these web views.

## Dedicated calendar setup for publishing

The optional setup at `/connections/google/publish` has its own Google connection
purpose, separate from Calendar reading and Contacts. Configure
`GOOGLE_CALENDAR_PUBLISH_CLIENT_ID` and `GOOGLE_CALENDAR_PUBLISH_CLIENT_SECRET` with a
dedicated web client, distinct from login and both other resource clients. Enable
Calendar API and register the same connector callback on this client. Existing
Contacts and Calendar reading grants keep their own credentials and resource settings.

Publishing requests basic verified identity, `calendar.calendarlist.readonly` and
`calendar.app.created`. Google's latter scope permits secondary calendars and their
events; it does not request event-writing access to all calendars. Calendar-list
metadata supplies recovery discovery. Sign-in or successful consent alone does not
create a calendar. [Google Calendar scopes](https://developers.google.com/workspace/calendar/api/auth).

Review the account and timezone, save that setup, then confirm creation of an empty
secondary calendar named Everclose. No people, event invitations, plan records,
private CRM notes or confirmed interactions are copied by setup. Saving the review
contacts only Everclose; creation is a separate explicit action. A preparation with
an unconfirmed save remains frozen in tab storage until authoritative review or an
identical retry resolves it. A definitely rejected timezone can be corrected. Accepted
timezone aliases are normalized to a name and shown again before creation; numeric
offsets are rejected before saving because Google requires an IANA timezone name.
[Calendar properties](https://developers.google.com/workspace/calendar/api/v3/reference/calendars).

Google assigns the secondary calendar ID, so this create call cannot supply a
client-chosen calendar identity. Before sending, Everclose durably records an attempted
marker, the immutable request, a random recovery marker and its creator OAuth client
ID. A lost reply, malformed acknowledgement or failed local completion transaction
never clears the marker to repeat creation. Later actions only verify the original
calendar. [Calendar creation](https://developers.google.com/workspace/calendar/api/v3/reference/calendars/insert).

An unknown ID is discovered by the exact recovery marker in owner calendars, including
hidden entries. Discovery completes at most four pages and 1,000 entries before
accepting one unique calendar. Empty, ambiguous, invalid or incomplete results remain
unconfirmed. A known ID is verified directly with ownership and marker checks. An
externally renamed calendar can still match; the page labels the original **chosen
setup timezone**, rather than claiming it is the current Google timezone.
[Calendar-list discovery](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list).

Only the current web-authenticated owner can prepare, advance or discard setup; writes
check the app origin and bounded exact request shape. A lease serializes advancement.
Fresh owner membership, authorization, dataset epoch, grant expiry and lease checks
fence the outward create and completion transaction. Earlier unsent consent or a
changed OAuth client requires discard and another review. After a request was attempted,
reconnection or CRM recovery permits explicit read-only verification of its original
calendar, never another create. Verification under a changed OAuth app does not prove
that the new app can write events on a calendar created by the previous one; the frozen
creator ID is retained for subsequent publishing permission checks.

Migration 43 adds this operational record and extends immutable provider purposes.
CRM backup schema 14, native schema 13 and transport version 4 stay unchanged. Setup
and credentials are excluded from CRM exports; restoration holds retained setup without
rolling Google back, and workspace erasure deletes the local operational rows. An
unsent, unleased setup can be explicitly discarded. Once attempted, it cannot be
discarded or replaced through this flow. Removing the calendar, marker or owner access
can leave verification unresolved; inspect Google Calendar and connection access.
This flow does not remotely delete calendars.

Dedicated setup is a locally verified foundation. The plan publishing implementation
below adds reviewed event creation and updates. Real-account consent,
actual Google secondary-calendar behavior, credentials, public approval where applicable,
production migrations and native release checks remain open. Tests use simulated Google
responses and disposable databases; no calendar was created in the owner's account.


## Publish an Everclose plan

After dedicated setup is ready, choose **Publish a plan** and select an open plan.
The connection-specific plan directory is paginated; the publishing page uses the
plan's stable public identity. Review title, location, private/default/public/confidential
visibility, exclusive all-day end dates or explicit timed dates with an IANA timezone,
up to 20 invitee emails and the default-off plan-date following choice. New titles use
the activity and person's name; private plan summaries and notes are not copied.
Nonexistent clock-change times are rejected. Repeated local times require their UTC
offset before review can be saved.

Saving the review is a local preparation, followed by a separate confirmation to
publish. Both confirmations show the event details and guest effects. Publishing
with guests requests Google invitations/update notices for all guests, including
removal notices where applicable. A creation without guests omits attendees; it does
not add guests while asking Google to suppress their invitations. Update requests
preserve unspecified event fields. An unchanged guest list is omitted from PATCH;
a changed list retains existing writable guest responses and comments transiently
under the original version, without adding those comments to CRM records or frozen
requests. [Google event patch semantics and notifications](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch).

One publication binds the plan to its original account, app-created calendar and
client-chosen event ID. The create and every retry use that same ID. Before an outward
request, Everclose durably records the attempt and frozen review. Verification reads
the original event and checks its publication/operation markers. An uncertain reply
or failed local completion transaction can therefore be reconciled without another
insert or invitation. A retry first reads that ID; a known confirmed event that has
disappeared is never recreated. Updates use the reviewed eTag with `If-Match`; a
changed remote version requires another explicit review. Private operation markers
use PATCH without replacing other extended properties.
[Google conditional requests and provided event IDs](https://developers.google.com/workspace/calendar/api/guides/version-resources),
[Google extended-property updates](https://developers.google.com/workspace/calendar/api/guides/extended-properties).

Accepted events become canonical saved Calendar context and link to the reviewed
plan. Existing notes, interaction history and completion stay unchanged. Private and
confidential canonical event facts remain redacted, including in version-4 native
sync; the owner's editing preview reads live details through the publishing grant.
Old verification updates existing context but does not recreate removed context or
reattach a detached plan. A fresh event review is needed to explicitly save that
context again. Source-first people/context associations retain the existing read
workflow.

If date following is selected, verified publishing can update only the open plan's
date. Complete manual or recurring event refreshes through the separately consented
reading connection can subsequently follow the observed start's civil date in its
timezone. Staged pages do not change the plan before the complete generation commits.
A manual plan-date correction, completion, cancellation, removed link, changed
consent or recovery suspends following. It never invents an interaction or marks the
plan complete. Enable Calendar reading and select the dedicated calendar if ongoing
refreshes should supply these source changes.

Routes are `/api/connections/<connection>/plan-publications/<plan>` for review,
preparation and unsent discard, and `/step` for explicit sending or verification.
Only the current web owner can use them. Origin, exact bounded bodies, account/client
identity, epoch, authorization, plan/canonical revisions, leases and grant expiry
fence publication and completion. Tab storage retains an unconfirmed preparation
for exact retry across reloads. An unattempted, unleased review can be discarded;
an attempted review retains its receipt and must be verified or replaced by a fresh
conflict review. The original account/calendar binding remains after discard;
transferring a plan's publication to another account is not implemented.

Migration 44 adds the operational publications and immutable write reviews. CRM
backup schema 14, native schema 13 and transport version 4 remain unchanged.

The build-11 release branch also adds migration 49's shared publication ledger.
Google preparation acquires its plan slot atomically against upgraded native
publishers; existing Google receipts are backfilled without changing prior rows.
Attempted, saved and unknown external effects keep their slot across restoration
and provider removal. This extension is not deployed. See
[shared Calendar coordination](calendar-publication-coordination.md) for tested
scope and the remaining legacy/session/source-identity work.
Operational receipts and credentials are excluded from CRM exports; restore retains
and holds the local receipts, disables following and preserves restored canonical
links. No source event, remote calendar or invitation is rolled back by CRM recovery.
Only the isolated local D1 database has received this migration. Real Google OAuth,
actual invitations and external edits, production migration/deployment and an
installed native iPhone remain release gates. Tests use simulated provider responses.
