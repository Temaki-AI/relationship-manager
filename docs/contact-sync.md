# Device sync protocol

This is the device sync foundation for the [product development plan](product-development-plan.md). Version 1 covers contact scalars and deletions, revocable device sessions and account-isolated native reconciliation. The current development iPhone client uses version 4 for contacts, interaction history, reminders, plans, family entries, relationships and read-only saved Calendar context, while retaining exact version-1, version-2 and version-3 requests awaiting a reply. These changes are not deployed to production and real OAuth/iPhone journeys remain unverified. Merged contact identities are retained on cloud and phone; source provenance and provider integrations remain required work.

## Identity and storage

Migration `0024_contact_sync_foundation.sql` preserves integer CRM IDs and adds an immutable `contacts.public_id` UUID. Existing rows receive UUIDs; ordinary web inserts receive UUIDs through a database trigger. Phone-originated creates may supply their own UUID through the sync API. IDs are canonical lowercase UUIDs and are scoped by the authenticated workspace.

Database triggers maintain `sync_contact_records`, the latest contact projection and revision, and `sync_changes`, an ordered change journal. This captures ordinary web edits, direct SQL imports, history-derived contact dates and deletions without requiring every existing route to call a publisher. A no-op write does not publish an extra revision unless its stored projection changes. Embedded photo bytes and remote photo URLs are excluded; `photo_available` indicates whether a photo is stored. The existing private photo read endpoint uses the returned integer `legacyId`.

Deleted contacts leave a tombstone in the mirror. Their public UUID cannot be recreated by another sync create. Earlier journal entries can still contain the old projection; workspace erasure removes them. Snapshot restoration replaces the journal and receipts, rather than including those transport artifacts in portable CRM backups.

The shared TypeScript contract is in `packages/domain/src/sync.ts`. It has no Next.js, Node or native imports. Contact `data` uses stored scalar values, including serialized JSON strings for tags, gifts and custom fields. Create and patch input use the existing CRM input formats: tag and gift arrays and a custom-field object.

## Authentication and routes

All three routes require an Everclose web session or a valid native device bearer credential, with current workspace membership checked through the cloud dispatcher. Middleware rewrites only supported versioned paths. They return `Cache-Control: no-store`. Provider access credentials are not accepted as Everclose sessions. Private photo reads still require web-session authentication; native photo transport is not part of the device grant yet.

### Device authorization

Migration `0025_device_sessions.sql` adds hashed authorization codes and device credentials, separate from CRM snapshots. The native client generates a random state, PKCE verifier and random device credential, saving them in Keychain-backed SecureStore before opening the system authentication browser at `/connect-device`. After real web sign-in, explicit approval calls `POST /api/v1/devices/authorize` with the S256 challenge, state and device label. Only the configured web origin and a current web-authenticated member may approve.

Approval returns a fixed `bonds://auth` callback with a five-minute code and state. The native client checks both, saves the code, and calls public `POST /api/auth/device/exchange` with code, verifier, state and its pre-generated credential. The transaction claims the code, creates a 30-day session and returns the account identity. The exact code/credential exchange can replay after response loss during the code lifetime; changing the credential cannot take over a consumed code. There are at most five pending requests per user and ten active devices per user/workspace.

Native credentials authorize bootstrap, pull and push under `/api/v1/sync`, `/api/v2/sync`, `/api/v3/sync` and `/api/v4/sync`, `POST /api/v1/device-sources/push`, and `GET`/`DELETE /api/v1/devices/session`. Hash, expiry, revocation and current membership are checked on every request. Invalid bearer credentials do not fall back to a web cookie. `GET /api/v1/devices` and `DELETE /api/v1/devices/<uuid>` require web authentication and manage only the current user's devices in the current workspace. Security inspection/revocation remains available during maintenance. Erasure deletes authorization codes and revokes workspace device sessions. Revocation does not remotely delete a disconnected phone's offline cache.

The native return scheme retains its earlier Bonds name for compatibility. Device registration does not grant access to Google Contacts, Gmail or Calendar; those require separate connector consent and storage.

### Bootstrap

Start with `GET /api/v1/sync/bootstrap` without a cursor. The response is:

```json
{
  "version": 1,
  "entities": ["contact"],
  "cursor": { "epoch": "709357ef-d2c6-42c7-b254-5b3fe44b9a84", "sequence": 23 },
  "records": [{ "id": "73b8a01b-a687-413b-9c09-47cda20e4338", "legacyId": 42, "revision": 3, "deleted": false, "data": { "name": "Ana" } }],
  "next": null
}
```

The example abbreviates `data`; actual records contain the full scalar projection. A non-null `next` contains `epoch`, `sequence` and `after`. Send those as query parameters on the next bootstrap request. Every page must have the same epoch and journal head. An intervening contact write produces `409` with `code: "bootstrap_changed"`; a restore produces `epoch_changed`. Start a fresh download while retaining the existing replica and local drafts. Commit a staged bootstrap only after its final page, then use its cursor for pull. The client must bind staged data and cursors to the account and workspace.

### Pull

Use `GET /api/v1/sync/pull?epoch=<uuid>&sequence=<number>`. The response contains `version`, ordered `changes`, `more` and the next `cursor`. Each change contains its sequence, `entity: "contact"` and a record with the same shape as bootstrap. Tombstones have `deleted: true` and `data: null`.

Sequences increase globally, so gaps are valid. A cursor is always scoped to the authenticated workspace and epoch. A future sequence or malformed cursor is rejected. Apply the entire page and save its new cursor in one local transaction; only then request another page. Keep pulling while `more` is true.

Pages contain at most ten records and approximately 1 MiB of record JSON; one record may contain at most 512 KiB. A larger existing contact produces `413` with `record_too_large`, requiring its text fields to be reduced before sync. These are explicit supported limits, not a quota test against live D1.

### Push

Send one durable operation per `POST /api/v1/sync/push`. Requests are limited to 256 KiB. A create example:

```json
{
  "version": 1,
  "epoch": "709357ef-d2c6-42c7-b254-5b3fe44b9a84",
  "mutation": {
    "operationId": "818d855f-e44e-4bda-bb05-4d74276d7f4b",
    "contactId": "73b8a01b-a687-413b-9c09-47cda20e4338",
    "type": "create",
    "data": { "name": "Ana", "email": "ana@example.com" }
  }
}
```

An update has `baseRevision`, `patch` and `base`, whose keys exactly match the patch. `base` carries the original stored scalar values. For example, an email patch supplies `base: { "email": null }` and `patch: { "email": "ana@example.com" }`. When the revision has advanced, the write succeeds only if every patched field still equals its supplied base. An edit to another field can therefore merge; edits to the same field produce a conflict. A base revision ahead of the server cannot write. Arrays and custom-field objects are treated as whole fields in this slice.

A delete has `baseRevision` and no data. It requires an exact current revision and a verified pre-delete CRM snapshot in R2. Storage failure or a workspace change during capture prevents deletion. Interactive recovery's existing 16 MiB limit still applies.

Mutation receipts commit in the same D1 batch as the CRM write and triggered journal entries. The response contains `version`, `replayed` and `result`, with the operation ID, `status: "applied"` or `"conflict"`, and the observed record or null. A conflict is a completed response with HTTP `200`; retain the user's patch for explicit resolution. Resolution uses a new operation ID and reviewed base values. Reusing an operation ID with different content returns `409`.

After an uncertain response, retry the same operation ID and exact body. The persisted result is returned without another write, even if the contact subsequently changes. Treat the result as an acknowledgement of that operation, then pull current state. Do not rewrite an uncertain request under a new ID or replace its receipt with the latest record.

## Version 2 history and reminders

Migration `0026_history_reminder_sync.sql` adds immutable public UUIDs to interactions and reminders, preserving integer IDs and parent references. `sync_entity_records` stores their projections, revisions and tombstones. Database triggers publish web creation, editing, completion, reparenting during merges and cascaded deletion to the common journal. Backfill seeds current projections without replaying old history. Interaction `occurred_at` retains an exact phone timestamp when supplied; existing web history keeps its civil `date` and a null timestamp. Editing that date on the web clears an old timestamp; editing other fields preserves it.

Use `GET /api/v2/sync/bootstrap`, `GET /api/v2/sync/pull` and `POST /api/v2/sync/push`. Bootstrap advertises exactly `contact`, `interaction` and `reminder`; records carry `entity` alongside the existing ID/revision/data envelope. They sort by entity and UUID, with contacts first. A continuation includes `entity`, `after`, `epoch` and `sequence`; the entire workspace head must still match. Pull includes all three entity types in journal order. Version 1 filters its pull to contacts and advances over unrelated journal entries without returning unsupported records.

Each child projection's `data.contact_id` is the parent's public UUID. Integer `legacyId` stays available for existing web routes. Interaction data includes `date`, nullable `occurred_at`, `type`, nullable `summary`/`notes` and `created_at`. Reminder data includes `title`, nullable `notes`, `remind_at`, nullable `completed_at` and `created_at`. Timestamps accepted by push normalize to UTC. A non-null interaction timestamp must agree with its civil date in UTC. A phone date edit must explicitly include `occurred_at` and its original base value, using null for a date-only record.

Push names `entity` and `entityId` instead of `contactId`, with `version: 2`. For example, completing an existing reminder sends:

```json
{
  "version": 2,
  "epoch": "709357ef-d2c6-42c7-b254-5b3fe44b9a84",
  "mutation": {
    "operationId": "2a091589-baa1-43ec-a0cc-1f5e6dd17ac2",
    "entity": "reminder",
    "entityId": "bb96d209-4a92-4eb5-8a91-70e4e78b69e1",
    "type": "update",
    "baseRevision": 3,
    "base": { "completed_at": null },
    "patch": { "completed_at": "2026-10-03T11:00:00.000Z" }
  }
}
```

Child creates require a current parent UUID in the same authenticated workspace. An unavailable parent or previously used entity UUID returns a retained conflict, never a dangling row or an automatic recreation. Parent changes are not accepted in phone patches in this version; server merge writes still publish the changed parent association. Update/delete semantics use the same original-value merge rules, atomic receipts and verified pre-delete recovery as contacts. Operation IDs share one workspace/epoch namespace across entity types. Version-2 contact mutations use the same underlying fingerprint as version 1, so an already frozen contact request can safely replay during a protocol upgrade.

The transport contracts and strict response readers live in `packages/domain/src/sync-v2.ts` and `sync-v2-client.ts`. Readers reject malformed entity IDs, parent references, dates, acknowledgements and page positions before the client applies data. Native reconciliation downloads all three entities, retains exact already-frozen version-1 requests, holds old-epoch changes for review and preserves pending child fields. Separate history/reminder reviews offer current cloud values, explicitly reviewed phone values or a fresh copy of a removed item. Parent deletion retains dependent drafts. Copying a removed person creates fresh person and child UUIDs; it does not retarget an uncertain frozen request or recreate deleted IDs.

## Version 3 plans, family and relationships

Migration `0027_plan_family_relationship_sync.sql` adds immutable public UUIDs to `plans`, `contact_children` and `contact_relationships`, preserving integer IDs and references. Existing data seeds revision-1 replicas without replaying old work. Triggers publish ordinary web writes, plan completion, merge reparenting, linked-profile changes and cascaded deletion. A family entry whose linked profile is deleted retains its name and birthday and publishes a null link.

Use `/api/v3/sync/bootstrap`, `/api/v3/sync/pull` and `/api/v3/sync/push` with `version: 3`. Bootstrap advertises `contact`, `family`, `interaction`, `plan`, `relationship`, `reminder` in that order; records sort by entity then UUID so all contacts arrive first. Continuation, bounds, original-field merges, receipts and verified deletion follow version 2. Older versions filter unsupported journal entries while advancing the global cursor. Identical contact/history/reminder requests replay across supported protocol versions without rewriting their operation IDs or bodies.

`family` represents the existing child entry. Its projection has `contact_id`, nullable `linked_contact_id`, `name`, nullable civil `birthday`, `created_at` and `updated_at`. Both references are public contact UUIDs. Creates and link changes require an owned, current profile distinct from the parent and no duplicate link under that parent. A new link with a supplied birthday requires that birthday on the linked profile, matching the web rule. Name, birthday and linked profile are editable; the parent remains server-managed during merges. An unavailable or conflicting link returns a retained mutation conflict.

`relationship` is one shared pair, with `contact_id`, `related_contact_id`, `relationship_label`, `reciprocal_label` and `created_at`. Both contact references must be current, distinct and owned by the workspace. A reverse-direction create cannot duplicate an existing pair. Labels are editable independently; contact references cannot be changed by a device patch. Each profile renders the appropriate side's label from this single record.

`plan` has `contact_id`, `type`, civil `planned_date`, nullable `summary`/`notes`, nullable `completed_at` and `created_at`. Create an open plan, then complete it with an update supplying a null original `completed_at` and a non-null timestamp. Completion merges around disjoint fields and conditionally changes only an open plan. The same D1 transaction stores its receipt and creates one interaction from the resulting plan fields, with the normalized completion timestamp and date. That interaction's public UUID equals the completion operation UUID, correlating the phone's provisional history with the server result. An occupied or tombstoned history UUID returns a retained conflict. Concurrent retries, later completion attempts and a retry after a lost response cannot create a second interaction. A create may preserve a historical completion timestamp when explicitly copying an already-completed plan; it does not create another history entry. Reopening a completed plan is not supported by this contract.

The strict version-3 readers are in `packages/domain/src/sync-v3-client.ts`. They validate new parent/link identities, civil dates, labels, page positions and acknowledgements, reusing version-2 validation for existing entities. Phone database migration 4 adds these local tables and outbox types, preserving queue order, frozen requests and old-epoch drafts. Uploads wait for every referenced person to reach the cloud. Both relationship endpoints render the single shared record with the appropriate label. Native context forms keep their opening bases; agenda and context lists use 50-row pages and the profile selector searches names, email and phone numbers.

Phone plan completion saves its queue intent and provisional history in one transaction, without queuing a separate history create. Repeated completion does nothing. A cloud completion race remains reviewable; choosing the cloud result removes only unconfirmed provisional history and recalculates the contact date around other pending touches. Reviewed completion after restore uses a fresh operation and history UUID. Explicit copying of a removed person uses new person/plan/history identities; relationships with two removed people require both person reviews before upload. Copying a removed linked profile relinks an existing family entry using a fresh reviewed update, preserving the family entry's UUID. Exact frozen operations still resolve their receipts and never get retargeted by these choices.

## Merged contact identities

Migration `0028_contact_merge_aliases.sql` stores retired public UUIDs in the surviving contact's `merge_aliases` JSON array. This backed-up column is authoritative; `contact_merge_aliases` is a workspace-scoped derived lookup rebuilt by recovery. Merges flatten inherited aliases to the final survivor. Assignment belongs to the same guarded transaction as reparenting and deletion, so an index failure rolls back the whole merge. Retired UUIDs cannot be reused for active contacts. The supported limit is 10,000 aliases per person, with the existing sync record-size limit also enforced.

A deleted contact projection may include `mergedIntoId`. An update addressed to its original UUID may reach the current survivor only when every original edited field still matches, even if the numeric revisions coincide. Old create and delete operations never recreate a retired person or delete the survivor. The receipt retains the original operation and contact identity and can additionally return a validated `canonicalRecord`; exact retries preserve the original fingerprint and response. Old child-create references resolve to current owned contacts before guarded writes; self and duplicate connections remain invalid.

Phone schema 5 adds an alias registry without rewriting any outbox payload or frozen request. Complete downloads rebuild it from the new dataset in the same publication transaction. Old links, profile reads and selected-device recapture resolve to the combined person. Pending history, reminders, plans, family and relationships reparent locally. A connection whose endpoints collapse is held for review with its original draft. Disjoint original contact edits can upload under their old identity; overlaps compare against the survivor. A reviewed phone choice creates a fresh operation against the current canonical UUID and base. Pending old deletion cannot remove the combined profile. Restore still holds old-epoch edits and clears aliases absent from the replacement dataset.

## Contact methods

Migration `0029_contact_methods.sql` adds the authoritative `contact_methods` JSON
collection to each contact and its replica projection. A method has a stable UUID
within its person, an email/phone/profile type, a value, an optional label and phone
country, and a preferred flag. At most one method per type is preferred. The old
`email` and `phone` fields remain preferred-value projections; older scalar writes
update that method's value without changing its identity or deleting secondary values.
New collections are limited to 256 methods and 384 KiB. User input cannot assign
source provenance: it inherits guarded original legacy values or creates user-supplied
methods. This is not connected-provider provenance or an implemented connector.

Raw values and country context remain stored. Matching ignores formatting without
inventing a local number's country; different known countries, unknown-country local
numbers and explicit international numbers remain distinguishable. Secondary methods
participate in directory search, duplicate review and import matching. CSV and vCard
carry editable method metadata and IDs, but imported provenance is treated as user
supplied. A portable `X-EVERCLOSE-CONTACT-METHODS` vCard field retains arbitrary labels,
country hints and preferred choices alongside ordinary EMAIL/TEL/URL properties.
Private recovery retains authoritative source metadata. Clearing methods does not
restore old values from preserved raw vCard context on export or reimport.

An internal JSON `null` default marks an older creation path that has not supplied a
collection. The insert trigger creates methods from its scalar/import context before
the transaction ends. Explicit `[]` means no methods. The placeholder never enters a
sync projection; update guards and protocol readers require a valid array. Migrations
backfill before replacing projections, retaining contact IDs and the journal sequence.

Phone schema 6 preserves earlier caches and frozen requests. Captures persist method
IDs before their first upload. Method forms keep their opening collection and revision;
collection writes compare the original JSON even when numeric revisions coincide.
Overlaps retain a draft for explicit review. Review applies only fields changed from the
opening base to the current collection, keeping methods added by the web or a merge.
The phone cache overlays pending primary changes onto incoming methods explicitly;
it does not run cloud scalar triggers that could overwrite protected offline fields.
Upgrading a schema-5 cache requests a complete collection because the server backfill does not replay history. An offline provisional legacy method can attach to one unambiguous current value during explicit review; ambiguous originals stay separate. Older retry responses without the new field preserve current method IDs and the exact collection JSON. Exact retry receipts, alias routing and restore epoch rules still apply.

## Linked source records

Migrations 0030 and 0031 add `contact_source_links` and a read-only source revision on
each cloud person. Source records have public UUIDs and a workspace-scoped unique
provider/account/external identity. This release supports user-provided LinkedIn
profile URLs and name, headline, company, location, email, position and export connection-date observations. It does not fetch
LinkedIn, authenticate ownership of that profile, or establish a provider account.
Provider adapters and their account/credential lifecycle remain separate work.

Create a person from a source or attach the source to an existing person using the
same protected API. Creation and its receipt commit together. Exact retries retain
one link and one person; conflicting keys and already-linked profiles are rejected.
A creation request carries the dataset epoch from the opened form. Restore and erasure
invalidate it before another write can occur. Local restore also changes the source
form nonce. A removed link's earlier create receipt cannot recreate it.

Each fact retains its original value, latest observed value and last explicitly
applied value. Source edits never replace private notes or the contact name. Use source
name is a separate action guarded by the contact's full edit revision and the source's
revision/original facts. A stale action changes neither record. Unlink removes the
source record and its details, retaining the person and relationship history. Merge
reparents source records in the protected merge transaction; old create receipts
resolve to the current survivor. At most 32 links and 128 KiB of source projection
belong to one cloud person, with a bounded complete device record.

Source changes increment the person's read-only source revision and publish through
the existing contact journal. All three sync versions carry an optional `source_links`
JSON text projection. It is not an editable device field. Native schema 7 requests a
complete current projection while preserving frozen outbox requests. Source details
remain available offline; an older response without the field preserves the current
collection, while an explicit `[]` removes it. A copied removed person does not inherit
the old person's external identity. The phone currently opens the profile link and
displays saved source facts; linking and source edits use the web.

Migration 0037 extends the accepted fact vocabulary without changing the eleven-column
projection. [LinkedIn export import](linkedin-import.md) adds reviewed create/attach and
reimport with optional name/email acceptance, durable receipts and epoch/revision guards.
All seven fact kinds survive merge, schema-13 recovery and a new native offline cache.
Earlier strict four-field prototype readers can reject these new facts; use matching web
and native builds before staging or public distribution. No older binary compatibility,
compiled native build or physical-device verification is claimed.

## Restore, erasure and maintenance

### Selected iPhone contact review

Native schema 10 retains immutable review previews and local `device_contact_links`.
An explicit picker action checks Contacts permission and reads only the chosen contact's
name, emails and phones. Limited access can be managed separately; denied or inaccessible
contacts do not stage an import. A reviewed person and accepted fields commit with the
source audit and ordinary contact outbox intent in one local transaction. Email and
international phone matches remain suggestions. Names and countryless local numbers do
not establish identity. Confirmed existing-person edits preserve private fields, method
IDs, labels and preferred choices. Source-only reviews do not enqueue serialization-only
contact edits.

Exact retry receipts resolve merges without duplicating a person or reviving an unlinked
source. A changed opening person, source revision or known restore epoch requires another
review. Merges reparent local sources; a removed parent retains its source details until
explicit release. Unlink leaves accepted fields and private history intact. Source
collections have a 32-link/128-KiB bound, and unfinished previews expire after a day.

Accepted name/method changes use the existing v3 contract and reach web/other devices.
The signed-in review can explicitly share original/observed source facts and accepted-field
audits, including source values left out of the CRM profile. Earlier private source facts
never upload automatically; schema-9 observations require another selected-contact review
before sharing. Schema 10 clears only the projection cursor and preserves local facts,
receipts and frozen contact requests.

### Shared iPhone source details

Migration 36 adds `contact_device_links` to cloud storage. A device-only SecureStore UUID
scopes each opaque Contacts ID to its installation and stays independent of renewable
login credentials. These facts are authenticated device observations authorized by the
user; they are not a provider-authenticated address book. The server does not attest
ownership of an installation UUID. Publication requires a valid device session and
current workspace membership; web sessions may only explicitly unlink shared sources.

All three contact sync versions carry optional `device_links` JSON text. Its ten-column
projection is separate from the existing Google projection and is never a contact write
field. Older acknowledgements without it preserve the cache; `[]` removes shared details.
The choosing installation can hydrate its local OS links. Other phones read source facts
without using another installation's IDs to access their address books. A distinct private
local review of the same OS identity stays intact rather than being overwritten.

`POST /api/v1/device-sources/push` accepts a strict publish/unlink object with operation,
epoch, source and person UUIDs, installation ID, external ID and expected source revision.
Publish adds original/observed facts, audit and observation time. The cloud transaction
checks device authorization, workspace state, canonical parent, source identity and base
revision, and commits its receipt with the source write and journal update. Original facts
stay immutable. Exact retries return the current canonical source, including after merges;
they cannot recreate removed people or sources. New creates cannot reuse a source UUID
retired by a publication receipt in the same epoch. Unlink keeps accepted person fields.

The phone queues source operations in the same local transaction as the reviewed fields,
then sends them after ordinary contact intents are acknowledged. Contact and source writes
are separate server transactions; a successful profile write does not prove the source
publication succeeded. The source queue retains exact frozen requests after uncertain
responses, orders subsequent observations/unlink, and holds rejected revisions or obsolete
epochs for review. Discarding source uploads leaves ordinary contact edits intact. A queue
with an uncertain pending request must be synced before it can be discarded.

Each device source collection stops at 32 links/128 KiB. Complete contact projections stop
at 510 KiB, reserving 2 KiB for the 512-KiB record wrapper; source and later profile writes
that exceed this bound roll back. Portable and private schema-13 recovery include shared
sources and validate their parent/identity/size graph. Genuine older artifacts normalize
the absent table without changing their original manifest chain. Restores rotate epochs;
workspace erasure removes sources and their receipts. CSV/vCard exports contain accepted
CRM fields rather than raw source observations. Offline caches receive removal on sync;
revocation alone cannot remotely erase a disconnected phone.

### Phone local iPhone reading choices

Native schema 11 adds consent and field rules independently of the shared ten-column
source projection. Migration 10→11 retains cursors, observations, receipts and frozen
requests. Reading defaults to disabled; accepted fields default to keeping CRM values.
These choices stay on the choosing installation and are not restored or enabled by
shared source facts. Directory browsing requests only names, emails and phones in
50-row pages with one lookahead. A selected row is reread under current permission
before entering explicit create/attach review; browsing alone saves no CRM person.

Foreground runs check at most 20 consented linked entries, no more than hourly unless
requested manually, after prior contact/source intents settle. They never prompt for
expanded permission. Stable OS method identifiers track approved values; missing or
ambiguous slots require review. Explicit slot rebinding also requires an explicit field
reset. Local contact-edit triggers retain user corrections, including edits subsequently
reverted. Only one local device source may follow a person field. Accepted changes keep
the method identity, label, country, preference and private relationship fields.

Policy/source revisions, account scope, installation identity, epoch, pending intents
and the current account generation fence delayed observations. Merge reassignment and
restore disable reading until reviewed. The installed SDK can fold store failures into
not-found; failed reads therefore mark local access/unavailable/error status and never
delete the Everclose person. Person fields, new source observations, policy baselines and
outboxes commit together locally. Shared publication still waits for the separate cloud
acknowledgements described above. Another phone cannot inherit OS access or reading
consent. Cloud-visible read status, background scheduling, optional write-back and real
iPhone validation remain open.

### Cloud restoration and transport

`workspace_sync_state` holds an epoch and pause flag. Interactive restore rotates the epoch, clears transport state, restores the CRM graph and rebuilds the mirror in one transaction. Resumable restore rotates and pauses at apply entry, stays paused throughout partial writes and rollback, and rebuilds the mirror only after final graph verification. Erasure also clears the journal and receipts. A failed operation's transaction does not expose a partial mirror.

During maintenance, sync returns `423`. An obsolete epoch returns `409` with `epoch_changed`. The client must preserve pending edits, bootstrap the current dataset and offer reconciliation. It must never silently change an old outbox's epoch and submit it again; that would undo a user's restore or erasure. New replicas start at revision 1 and an empty journal head after replacement.

Cloud snapshots now write schema version 13, preserving all six entity UUIDs, exact interaction timestamps, authoritative contact merge aliases and contact methods, plus linked source records and their original/observed/applied values. Versions 1–12 remain readable; contacts from versions before 8 default to an empty alias list. Legacy rows without UUIDs receive deterministic namespace-based UUIDs so repeated reads, resumable writes and independent destination verification agree; namespaces include the table to distinguish equal integer IDs. Private manifests accept schema versions 4–13. Schema 12 adds provider field rules and schema 13 adds shared iPhone observations; phone-local reading consent remains outside cloud recovery. Schema 11 adds saved Google source identities, original/observed facts and accepted-field audit records; provider authorization and operational previews remain outside recovery. Earlier manifests default the new table to empty. Older source-less manifests retain their original part chain and table ordering and acquire an empty source table during validation. Contacts before version 10 default the source revision to zero. Contacts from versions before 9 acquire deterministic method UUIDs from their scalar and legacy import values, so repeated reads and independent restore verification agree. Recovery rebuilds both replica tables for all supported entities only after the replacement graph is verified, and erasure clears both. Private version-5 and version-6 fixtures without the new contact column pass resumable restoration and independent destination verification. Version-8 recovery rebuilds merged identities; an authentic version-7 contact chunk defaults absent aliases and clears the derived index.

## Rollout and remaining gates

Apply migrations 0024–0041 before deploying this application; readiness now requires 0041. All eighteen migrations have been applied only to isolated local development D1. [Google account connections](google-connections.md) adds encrypted operational authorization and staged address-book previews outside CRM snapshots, and fences provider jobs by authorization revision, credential revision, owner and dataset epoch. Contact methods, LinkedIn links, selected Google imports, saved provider provenance and source-aware private recovery pass disposable Worker/D1 checks. Phone schema 8 adds a separate read-only `provider_links` collection while retaining the existing LinkedIn `source_links` and method contracts. Saved Google facts survive offline edits and older acknowledgements; an explicit empty collection removes them. No remote migration has been performed. Prepare staging and verify recovery first. A production migration should run with workspace recovery/erasure jobs quiescent. Backfill uses existing recovery revision triggers and can invalidate unfinished captures. The migrations leave existing integer references intact, but older application binaries do not understand the new snapshot columns: prefer a forward repair or a reviewed database/application recovery procedure over an untested binary rollback.

The journal and receipts currently remain until restore or erasure. Add measured retention and cursor expiry before public release. Do not prune journal rows while accepting cursors that refer to the removed range, or forget create/delete receipts while still accepting arbitrarily old operations. Tombstones need a compatible stale-device policy.

The native implementation uses separate SQLite files per server/user/workspace with an ownership guard. Migration 2 retains legacy local rows and adds staging, original edit bases, frozen requests and conflict state. Migration 3 adds mixed-entity replicas/staging and preserves interaction civil dates separately from nullable timestamps. It recovers the known original completion value for a legacy reminder completed before its queued create was sent; unknown original values remain review items. Migration 4 extends storage and the outbox to all six entities. Bootstrap publishes only a complete download, parents first; pull commits each page and cursor atomically. Pending fields overlay incoming rows, including contact dates derived from unsent history and provisional plan completion. Editors capture their opening base/revision and queue only changed fields, so later incoming web values neither overwrite the form nor silently become its original base. Push stores an exact request before sending, processes each entity's intents in order and waits for every referenced person to reach the cloud. Frozen requests can still resolve their receipt after a referenced person is deleted. An older replay receipt cannot replace a newer downloaded projection.

Foreground startup/resume, local changes, a 30-second active-app timer and manual action trigger workspace sync. Restore/erasure holds old edits for explicit review. Review can adopt cloud values, submit reviewed phone values using a fresh operation and current base, or copy a removed draft to new UUIDs with its pending history/reminders. It rejects a changed review and concurrent transport. Incoming tombstones hide the person but retain local drafts. Web date-only history displays its date without inventing a midnight activity time. Reminder completion and schedule changes refresh the nearest 48 future phone alerts without requesting permission at startup; refresh cancels obsolete schedules and late scheduling results while retaining delivered alerts for the same account. Account changes discard late network results and clear delivered/scheduled alerts; disconnect clears credentials while keeping the cache and preserving separate local-only data.

Next work includes explicit local-only migration, more native profile fields/editing, People and timeline pagination, connected-source provenance and source links. Google credential storage and connection lifecycle now have a separate local implementation; real OAuth and provider-authenticated facts remain pending. Photos, Google/iPhone data connectors, contact source selection/link review, external calendars and Gmail remain outside this slice. Real iPhone/TestFlight and authenticated staging/production journeys are required before release. Native compilation needs Expo 57's required Xcode 26.4+; the installed toolchain is 26.2. Successful bundle export proves the JavaScript build only.


Google source reconciliation now refreshes the existing read-only `provider_links` projection without changing its fourteen-field contract or native schema 8. Explicit followed field values become ordinary contact changes. Web and device writes mark corrected or removed followed values as sticky overrides in separate backed `provider_field_rules`; older device acknowledgements cannot remove these rules. Rules use snapshot schema 12, with genuine schema-11 and earlier artifacts retaining their original part chains and defaulting missing rules to keeping values. Operational recurring settings remain outside recovery and device sync. The phone's source screen remains read-only; field-policy editing is available on the web.

Reviewed Calendar context uses canonical schema-14 CRM recovery with independent event, person-link and plan-link tables. Cloud protocol version 4 adds one read-only `source_event` record per canonical event, with linked person/plan public UUIDs, source facts, observation time and workspace source availability. Versions 1–3 remain compatible and skip these journal entries. The development phone now uses version 4 and schema 13. Earlier cursors skipped events, so upgrade to the schema-12 event cache requires a complete staged download. Schema 12→13 preserves that cache/cursor and adds an independent association outbox. Event replacement and cursor commit are atomic; interrupted downloads and local transaction failures retain the visible cache and pending edits. Agenda and person cards read saved facts offline, display source status/observation time and follow current person/plan identities. Native association editing now has a local implementation with reviewed public IDs, semantic base digests, durable offline intents, exact locked retries, monotonic acknowledgements and held-intent review. The queue never duplicates source facts. Real-device evidence remains required. Restore regenerates event projections under a new epoch while paused and requires source review; erasure clears them. See the Calendar documentation for the access/expiry rule and bounds. [Calendar context and limits](google-calendar.md) describes the web review and recovery behavior.


### Phone-local Apple Calendar receipts — 4 October 2026

Native schema 14 adds immutable reviewed drafts, attempt-before-editor receipts and
consented EventKit observations. These are operational phone-local records, outside
CRM recovery and protocol-4 canonical event facts. A verified optional date change
uses the existing plan outbox with its original base; notes, completion and history
are preserved. Receipt/plan/outbox writes commit atomically, other plan-date changes
stickily stop following, and bootstrap epoch changes hold old receipts/consent.
Existing schema-13 data, source links, pending intents and cursors survive upgrade.
Cloud D1 migration 44, CRM recovery 14 and protocol 4 are unchanged by this bridge.
Account-isolated receipt URLs cannot trigger editor actions by themselves. Source
sharing, cross-provider identity/reservation and physical native-build checks remain
required; see [Apple Calendar runbook](apple-calendar.md).
