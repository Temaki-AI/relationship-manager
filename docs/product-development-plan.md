# Everclose product development plan

Prepared on 3 October 2026; implementation status updated on 5 October 2026. The [working personal web release](personal-web-release.md) is now deployed at everclosecrm.com with verified Google sign-in and preserved existing contacts. This plan distinguishes that release from local native implementation, proposed work and integrated-beta requirements. Your personal use is the first product target; public distribution follows it.

Build Everclose into one personal relationship manager across the web and a native iPhone app. A person should be able to capture someone in seconds, connect that record to address books and supported accounts at any later point, see relevant conversations and events, and receive useful reminders without continually maintaining the database.

The recommended sequence is shared identity and reliable device sync, a polished mobile experience, contact connections, calendar integration, email context, and then broader automation. Provider registration and approval work starts early, alongside engineering.

Confirmed priorities are Google Contacts, Gmail, Google Calendar, iPhone Contacts and LinkedIn, for personal use first and public distribution later. Microsoft follows this first integrated release. The proposed native iOS approach is to continue the existing React Native and Expo application, adding Swift modules or extensions when platform capabilities require them. A complete SwiftUI rewrite is a separate product decision and is not assumed in these estimates.

### Personal use and public release

Build around the owner's existing Everclose account and contact database. Local development uses isolated storage, so an empty local database does not mean the hosted contacts have disappeared. Before any production migration, verify the authenticated account/workspace, inventory its data, export it and test a recovery copy in staging. Preserve existing people, notes, photos, relationships and history when adding source links or mobile identities. Production data must never be replaced by development fixtures.

| Release | What must be usable | Evidence before calling it ready |
| --- | --- | --- |
| Daily mobile alpha | Mobile web and an installed native iPhone app; Today, People, profiles, capture, interaction logging, plans and reminders; shared data with web; offline editing | The owner uses the same account on web and iPhone, sees existing contacts, restarts offline without losing drafts, reconciles conflicting edits and receives a reminder with the app closed |
| Integrated personal beta | The alpha plus Google Contacts, iPhone Contacts, Google Calendar, Gmail context and LinkedIn profile linking/export import | Both connecting before contact creation and linking afterwards work; recurring sync preserves notes and identity; revocation, duplicate sources and uncertain responses pass controlled real-account tests |
| Public release | The beta plus public authentication/account management, provider approvals where required, App Store distribution, accessibility, deletion, monitored delivery/recovery and support | Release checks pass at the advertised dataset size; permissions, retention, supported integrations and operational ownership are documented |

The personal beta is the first complete product target. General sales workflows, teams and additional providers do not delay that target. LinkedIn automatic connection sync is conditional on approved access; useful profile links and export import remain part of the beta. A personal pilot may qualify for Google's verification exception, but that exception must be checked against the actual use and does not establish readiness for a public service. [Google verification exceptions](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

The owner's audience choice is confirmed: personal use first, public release later. Prioritize making the existing hosted relationships usable on the owner's iPhone before adding public onboarding or billing. A personal beta is complete when the owner can use web and iPhone for a week with the same relationships, connect each of the five priority sources, review matches, capture offline, see upcoming meetings and correspondence context, and act on reminders without losing notes or creating duplicate people. Record problems from that week before widening access. Optional contact write-back, AI summaries, widgets, Android and additional social networks can follow this beta; they do not define its completion.

This document is the forward product plan. [Implementation roadmap](implementation-roadmap.md) remains the historical engineering log and source of outstanding release gates. Older audits describe the state at their dates; many of their findings have since been addressed. [Development setup](development.md) describes the local environment.

Implementation is underway. Contact identity, the change journal, recovery-aware APIs, revocable device sessions and account-isolated phone caches are documented in [Device sync protocol](contact-sync.md). The development phone and cloud now use version 4 for contacts, history, reminders, plans, family, relationships and read-only saved Calendar context, including staged downloads, conflict review and fresh identities for explicitly copied drafts. Native agenda and context forms support offline editing and correlated plan-completion history. Durable merge aliases preserve old identities through cloud and phone reconciliation, including original-base edits, history and conflict review. Multiple contact methods and web/phone editors also have a locally verified implementation, with preferred values, original legacy values, method conflict review and CSV/vCard transfers. User-provided LinkedIn links and reviewed Connections.csv imports now support creating a person or attaching to an existing one, preserving original observations, explicitly reviewing the CRM name/email, reimporting the same profile, merging and restoring links, and reading saved details offline on the phone. [LinkedIn export import](linkedin-import.md) documents bounds, uncertain-response recovery and the required matching web/native builds. Real-device verification remains open. Real OAuth/device journeys, broader provider resource permissions and the remaining integrations are required before milestone 1 is complete. The core version-4 service is deployed, and the installed owner’s iPhone has downloaded all 12 existing relationships with identities and original fields preserved. See the [personal iOS release](personal-ios-release.md) for actual build, installation, download and remaining physical-device checks.

Google Contacts authorization now has a locally verified account lifecycle: separate consent, verified provider identity, encrypted credentials, serialized refresh, revocation retries and restore fences. [Google account connections](google-connections.md) describes setup and limits. Staged full and incremental address-book downloads now support explicit review, stable contact-source IDs, atomic publication, queue checkpoints, expired cursors and permission/recovery fences. Reviewed create/attach imports now preserve private relationship fields and preferred methods, save provider-authenticated original facts, survive merges and recovery, and reach the phone offline. Bounded recurring reconciliation and explicit per-field choices now preserve corrections, retain missing sources, suspend choices after merges, and support opt-in daily/hourly downloads. These are locally verified implementations; real-account evidence remains required. Google endpoints are simulated in the tests, so real authorization remains a release gate.

Selected iPhone Contacts capture now has a locally verified review flow: choose one system contact, confirm a new or existing Everclose person, and explicitly accept its name, emails or phones. Matching proposes candidates without choosing one automatically. Private history and existing preferred methods remain intact. Permission denial and limited-access failures leave the database unchanged; limited-access management is available separately. Accepted fields use the existing contact outbox. Explicitly shared original/observed iPhone details now have a separate durable queue, reach web and other phones, and survive merges and recovery. Previously local source details stay private until reviewed and shared. Address-book IDs are scoped to the choosing phone; another phone can read shared facts without treating those IDs as its own Contacts entries. Consented directory browsing, bounded recurring reads and explicit field choices now have a locally verified implementation. Reading defaults to disabled on the choosing phone; corrections remain protected until explicitly reset. Permission loss, merges, restores and delayed results retain relationship data. Shared facts do not grant another phone Contacts access. Cloud-visible source availability, SDK permission behavior, native binaries and physical-device journeys remain release checks.

Google Calendar now has locally verified separate resource consent, encrypted credential refresh, staged calendar-list discovery, explicit choices, and staged manual and opt-in recurring event downloads with a web review. Event pages preserve timezones, all-day dates, recurring occurrence identity, cancellations and partial participants; private details are redacted before storage. [Calendar connections](google-calendar.md) documents scopes, project-wide revocation, bounds, cancellation and recovery fences. Existing Contacts grants retain their resource identities. Canonical saved events and explicit people/plan associations now have a locally verified web implementation, including source-first saving, ambiguous participant suggestions, edits after disconnect, merge preservation, exact retry and schema-14 CRM recovery. Saved context is reachable from Calendar and person actions; it does not modify plans or log interactions. The cloud now offers version-4 saved-event sync with public person/plan references, source availability, privacy updates, tombstones and restore epochs, while preserving versions 1–3. The phone now has schema-13 staged event downloads, a durable association outbox and offline mixed agenda/person cards, including source-first context, strict dates, source status, merges, removal, restore and exact older retries. Unified web month/agenda cards and three-card person previews now have a locally verified implementation, including current plan-owner filters, bounded source responses, multi-day spans, explicit uncertain dates and responsive column constraints. Native association editing and its offline queue now have local implementations, with reviewed people/plan selections, exact retries, explicit conflict resolution and account/recovery fences. Recurring event jobs, rolling windows, interruption repair and explicit daily/hourly controls now have local implementations. Separate consent and optional dedicated-calendar setup also have a locally verified foundation: review the account/timezone, confirm an empty calendar, and discover the original after an uncertain creation reply. Plan publishing now has a local implementation with two explicit reviews, invitation effects, stable event IDs, eTag-protected updates and reconciliation after uncertain replies. Canonical context reaches version-4 sync; optional date following changes only an open plan date and suspends on manual correction, removal or recovery. Real-account publishing, the Apple Calendar bridge and Gmail remain required. Real native validation and unattended real-account refresh remain required before calling Calendar integration usable. Tests simulate Google endpoints; actual consent is unverified.

The installed personal iPhone release preserves contact and journal drafts, pages through People and older timeline entries, and safely orders reminder scheduling. Hosted-photo downloads and a 64-image account cache are deployed. Native photo selection, explicit preview/save, offline drafts, a durable upload outbox and conflict review now pass 796 root tests; all 15 photo/recovery journeys also pass against real D1. Build 2 was withdrawn after a native framework ABI mismatch was confirmed. Build 3 compiles the modules from matching sources and adds a linkage check before distribution. Both Release builds and isolated SQLite/Keychain startup pass in run 37263450401; the signed build is installed. The preceding database was preserved exactly through rollback, while a fresh post-build-3 database comparison awaits permission for a private local verification copy. Physical post-upgrade launch/photo selection, Calendar/reminder delivery, TestFlight and the complete integration pilot remain release requirements.

Gmail metadata transport now has a fixture-verified implementation for mailbox identity, label discovery, bounded message metadata and incremental history. It requests no bodies or attachments, keeps subject retention explicit and preserves exact history IDs. This is not yet a usable Gmail connection: separate consent, durable staged storage, reviewed matching, web/native context and real-account evidence remain required. [Gmail implementation](gmail.md) records the provider contract and remaining work. Compatible security patches reduce the audit findings while preserving native framework versions; unpatched and incompatible-update findings remain a public-release gate. [Dependency security](dependency-security.md) records the exact evidence.

## What exists and what remains

This assessment uses the current checkout at base commit `53631a8`, including local development setup, six-entity device sync and durable merged contact identities. Source, SQLite, disposable Worker and bundle checks support the implementation notes; external accounts and all production workflows were not retested for this plan.

| Area | Current evidence | Work still needed |
| --- | --- | --- |
| Hosted web | Next.js on Cloudflare, Google login, workspace ownership, D1 and private R2 storage | Complete real local OAuth, establish a separate staging environment, verify authenticated release journeys |
| Core CRM | People, relationship and family context, timelines, tags, reminders, Today actions, calendar, imports, exports and duplicate merge; locally verified multiple contact methods and transfers | Real authenticated method/editor journeys, shorter mobile profiles, direct event editing, consistent capabilities and navigation, regression coverage across devices |
| Native app | Expo and React Native, account sign-in code, isolated device SQLite, six-entity reconciliation and review, offline saved Calendar cache/cards, agenda/context forms, reviewed iPhone create/attach capture, consented browsing/recurring reads, field rules, explicit source sharing and durable outboxes | Real Google/iPhone journey, real native Calendar link/editor validation, cloud-visible iPhone source availability, physical photo/editor validation, broader accessibility and TestFlight |
| Connected accounts | CSV/vCard transfers, reviewed LinkedIn profile linking/export import, locally verified Google Contacts lifecycle/import/reconciliation, consented iPhone reading/reconciliation with shared source facts, separate Calendar consent/discovery/choices, manual and opt-in recurring event download/review, saved event/person/plan context, native offline transport/cards and unified web agenda/profile previews | Real Google authorization, actual-export validation, real-device iPhone reconciliation, shared source availability, Gmail, actual-device association/editor checks, real-account recurring Calendar/publishing validation, Apple context sharing/cross-source coordination and Gmail remain required |
| Recovery | Verified bounded snapshots, restoration, encrypted portable exports; advanced recovery and queue foundations | Deployed recovery drills, large-data limits, retention and external-sync-aware restoration |
| Delivery | Native local notifications; cloud email reminder and backup scheduling code | Production config has email delivery, automatic backups and large recovery disabled; activate each only after its operational checks |
| Quality | Extensive unit, Worker and selected browser tests | Real OAuth and iPhone journeys; resolve recorded dependency audit findings; production-scale and provider-failure checks |

Source anchors: [mobile boundary](../apps/mobile/README.md), [mobile schema](../apps/mobile/src/data/schema.ts), [cloud schema](../lib/cloud/schema.ts), [capabilities](../lib/data-capabilities.ts), [production configuration](../wrangler.jsonc), and the [implementation log](implementation-roadmap.md). Historical test counts are evidence of earlier checks, not a new test run.

## Product experience

### Essential journeys

1. **Connect before creating contacts.** Connect an address book, choose people or groups to bring in, review possible matches, and create or link records. Repeat sync updates the same records. Email correspondents and event attendees enter a suggestion inbox rather than automatically filling People with strangers.
2. **Create first and connect later.** Create Ana manually with a phone number. Later connect Google Contacts and link the matching Ana record. Keep the same Everclose person, notes, reminders and history. Add her email, device contact and social profile to that person over time.
3. **Find someone in another app.** Share a profile URL, vCard or selected text into Everclose. Choose an existing person or create one. Preview extracted fields and their source before saving.
4. **Connect an existing contact to another source.** Use a profile's Connections action to search an authorized source, review suggested matches, unlink a wrong match or choose what fields can update. No full reimport is required.
5. **Connect a calendar before or after planning.** Bring in selected calendars, associate attendees with existing people, and show upcoming meetings on their profiles. Create a plan in Everclose and optionally publish it to a chosen calendar. Link an existing plan to an existing event without creating another event.
6. **Work offline.** Capture a person, note, interaction or reminder on the phone without reception. On reconnect, send each change safely, show any conflict, and make the result available on the web.
7. **Act on useful context.** Open Today, see why someone is there, review the last relevant interaction, reach out through the chosen app, and confirm or log what actually happened.

Opening a phone, email or messaging app never counts as a completed interaction. A calendar invitation also does not prove that a meeting happened. Suggested activity and confirmed relationship history stay distinguishable.

### Mobile web and native iOS

Use a shared navigation model: Today, People and Calendar, with prominent quick capture and a More area for Connections and Settings. Test the exact tab arrangement on an iPhone before committing to it.

| Surface | Planned experience |
| --- | --- |
| Today | Small, relevant queue; clear birthday, reminder and check-in reasons; Reach out, Log, Done and Snooze actions |
| People | Fast search, small-circle favorites, useful filters, visible source status and a recent activity preview |
| Person profile | Overview, Timeline and Details; contact methods and quick actions remain easy to reach; connections and field provenance available without overwhelming the main screen |
| Calendar | Agenda first on phones; editable plans and reminders; external events visibly identify their source and write permissions |
| Capture | Minimal required fields; save a draft; choose create or attach; later add tags, relationships and context |
| Connections | Account identity, selected data, direction of sync, last successful update, pending changes, conflicts, reconnect and disconnect |
| Settings | Timezone, notification privacy, connected devices, account security, export, recovery and deletion |

Mobile web work covers safe areas, keyboard overlap, reliable Back behavior, large tap targets, readable forms, draft preservation, Safari, installation, loading and error states, and accessibility. Keep bulk cleanup and complex import tools especially efficient on desktop.

Native iOS adds offline storage, system contact access, calendar integration, share extension, Face ID lock, local notifications and push, universal links and later Shortcuts/widgets. Ship a real native build through TestFlight; Expo Go and JavaScript bundle export alone do not validate these capabilities. Core profile data must remain available on iOS even if infrequent administration initially opens the web.

## Architecture and ownership

### Shared cloud service

Retain Next.js, Cloudflare Workers, D1 and R2 initially. Add a versioned API used by the native client and eventually by both web write paths and integrations. Share validation, domain types, matching rules and date logic in a package that does not depend on Next.js, browser globals or native modules. Keep mobile and web dependency isolation.

Use Cloudflare Queues for bounded connector jobs, a separate dead-letter queue, and scheduled renewal/reconciliation jobs. Keep integration queues separate from recovery queues. D1 holds the authoritative CRM state; iOS SQLite is an offline replica. R2 stores authorized private artifacts. External providers remain authoritative for their own event and source records.

Measure D1 query, transaction, storage and Worker CPU limits with representative datasets before choosing database sharding or another database. A platform rewrite is not a prerequisite. Maintain existing SQLite deployment behavior during shared-code changes; bringing all new cloud connectors to self-hosting is a later scope decision.

### Authentication and consent

- Separate **signing into Everclose** from **connecting a data source**. Google login must not silently grant Contacts, Gmail or Calendar access.
- Support multiple personal/work provider accounts with distinct scopes and sync settings. A connection belongs to an authenticated owner and workspace.
- For native sign-in, use the system authentication session, state/nonce checks, authorization-code flow with PKCE where applicable, verified return links, and revocable device sessions. Keep provider client secrets on the server and native credentials in Keychain-backed storage.
- Add Sign in with Apple before public iOS release, with explicit linking to an existing Everclose account. Never join accounts solely because display names or unverified email addresses match; handle Apple's private relay addresses.
- Encrypt connector refresh tokens using a versioned application key kept outside D1. Exclude secrets from logs and portable CRM backups. Serialize token refresh and support revocation and reauthorization.
- Review social-network credential storage separately before implementing a social connector. Do not assume the cloud token vault is permitted for it; Apple's social-network credential rules can require on-device storage and direct, foreground access.
- Separate local, staging and production OAuth clients, databases, buckets, queues and callbacks. Start Google verification and Apple distribution setup during the first milestone.

For the personal pilot, explicitly record Google's publishing status, allowed users, granted scopes and reconnect behavior. External apps in Testing receive refresh tokens lasting seven days when requesting data scopes beyond basic identity. A login-only test therefore cannot establish reliable Contacts, Calendar or Gmail access. Test refresh failure and reconnect without deleting imported relationships. [Google refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration).

Sign in with Apple is the proposed way to satisfy Apple's equivalent-login requirement for a public app using Google sign-in; applicability and exceptions must be checked for the final distribution model. Account deletion must cover identity and linked credentials as well as CRM records. [Apple review guidelines](https://developer.apple.com/app-store/review/guidelines/#login-services) and [account deletion guidance](https://developer.apple.com/support/offering-account-deletion-in-your-app).

### Data model changes

Use additive migrations. Preserve current integer primary keys internally and introduce immutable public UUIDs plus mapping records; do not renumber production contacts. Migrate existing mobile UUIDs and local records through a reviewable first-sync process.

| Record | Purpose |
| --- | --- |
| Person and contact methods | One canonical person; multiple labeled emails, phones and profile URLs, with preferred values and conservative normalization |
| Connected account | Provider account ID, granted scopes, credential reference, selected resources, direction and lifecycle status |
| External record link | Workspace, provider account, resource type, external ID, canonical person ID, provider version and source metadata |
| Field provenance | Source value, last observed value, user override and field-specific update policy |
| Device and sync cursor | Revocable device identity, acknowledged server sequence, schema compatibility and last successful sync |
| Change log and tombstone | Ordered per-workspace changes and deletion markers with defined retention |
| Mutation receipt | Idempotency key, request fingerprint, resulting revision and acknowledgement |
| Source activity and participants | External message/event identity, participants, dates and attribution to one or more people |
| Calendar and event link | Provider calendar/event IDs, recurring series and occurrence identity, permissions, timezone and linked plan |
| Connector run and outgoing operation | Cursor/checkpoint, retry state, provider receipt, errors and uncertain write outcome |
| Match decision and exclusion | Confirmed links, rejected suggestions and suppression of unwanted reimports |

Do not use name equality as proof of identity. Exact provider IDs establish source continuity; normalized email/phone matches suggest candidates but still need ambiguity handling for shared or recycled addresses. Preserve accents, raw values and phone-region context. Merging must reassign all provider links and activities and preserve aliases for old device IDs; provide recovery or an explicit split flow for mistakes.

### Device sync contract

1. Bootstrap a bounded, consistent snapshot and server cursor. Authenticate every request and enforce workspace ownership server-side.
2. Save local edits and their outbox operations in one SQLite transaction.
3. Push bounded batches containing operation UUID, entity UUID, payload version and base revision. The server commits the mutation, receipt and change-log entry atomically.
4. Return a result per operation. Retry an uncertain request with the same ID. Do not remove the local intent until its acknowledgement is saved.
5. Pull changes after the last durable cursor and apply them transactionally; retain pending local edits when rebasing the replica.
6. Resolve non-overlapping field changes automatically when safe. Show conflicting edits to the same field for review. Do not use device wall-clock time to choose a winner.
7. Propagate tombstones and merge aliases. Expired cursors require a full reconciliation; an old offline phone must not resurrect deleted people. Proposed tombstone window: 90 days, validated against the supported offline period.
8. Give restoration a new workspace sync epoch. Pause connector writes, invalidate stale cursors and receipts, and reconcile devices and sources explicitly. Restoring Everclose never silently rolls back Google or an address book.
9. Include every production write path in the change log, including existing web routes, imports, merges, connector writes and restore. Define version negotiation before releasing a mobile client that may stay installed for months.

Sync on app launch, foreground return, successful edits, explicit refresh and opportunistic background execution. Show pending, syncing, conflict, reconnect-required and last-success states. iOS decides when background work can run; push is a hint to fetch, not a guarantee of continuous execution. [Apple background execution guidance](https://developer.apple.com/documentation/backgroundtasks/choosing-background-strategies-for-your-app).

## Integration scope and sequencing

Read/import support ships before optional write-back. Every connector must support both first-time creation and attaching to existing people. A successful connection does not authorize copying all available fields or sending data to every other connected provider.

### Defaults for the personal beta

Use these proposed defaults to make the first release concrete. They can change after the personal pilot without delaying independent engineering.

| Choice | Initial behavior |
| --- | --- |
| Contact import | Preview selected people and possible matches; bring in approved fields; recurring updates are inbound only until write-back is separately enabled |
| Existing relationships | Keep the current person identity, private notes, history, reminders and family context when another source is attached |
| Field changes | Preserve user corrections; show conflicting source values and offer a deliberate reset to the source value |
| Calendar history | Selected calendars, 90 days of history and 180 days ahead; larger windows require an explicit backfill |
| Event publishing | Optional dedicated Everclose calendar first; preview participants and invitation effects before publishing |
| Email history | Start with up to 90 days of participant/date/direction metadata for existing people; no bodies or attachments; subject retention off by default |
| New correspondents | Suggestions only when enabled; never automatically create a person for every sender or attendee |
| Source deletion | Mark the external link unavailable; preserve the Everclose relationship unless its deletion is explicitly requested |
| Write-back | Off by default, enabled per connection and field; private CRM notes stay private |
| Distribution | One owner's account and installed iPhone app first; public registration waits for the public release checks |

Connecting a source before creating a person uses a bounded authorized source index and a review queue. Connecting after creation searches that source for a match and attaches its external record to the existing person. Both routes use the same link and matching rules, and re-run matching when another email or phone is added. A person can retain links to multiple Google accounts, one or more device records and social profiles without becoming several CRM contacts. Show ambiguous matches for review, including shared addresses and the same address book visible through both Google and iPhone.

### First integration releases

| Source | First useful release | Later expansion and limits |
| --- | --- | --- |
| iPhone Contacts | Selected people, then consented address-book reading and change reconciliation | Create/update selected contact fields in writable containers; respect limited access and managed/read-only contacts |
| Google Contacts | Selected import, link to existing people, incremental inbound sync | Explicit create/update write-back with field rules and provider version checks |
| Google Calendar | Selected calendars, upcoming events, attendee matching and profile context | Create/reschedule Everclose-owned events; separately enable editing other writable events |
| Apple Calendar | System event editor for saving plans; optional reading of selected on-device calendars | Device-mediated reconciliation; server freshness depends on the phone running |
| Gmail | Opt-in participant/date/direction metadata, bounded history, correspondence matching | Optional body features only as a separately justified scope and retention decision |
| Microsoft Outlook | Contacts and calendars, followed by email metadata, using the shared connector framework | Personal and work-account variations, delegated permissions and administrator policies |
| LinkedIn | Profile URL linking and user-provided exports; review the existing explicit capture extension | Automatic connection sync only if approved access and terms permit it |
| WhatsApp and iMessage | Contact actions, user-shared content and confirmed interaction logging | No general personal-message-history sync commitment; separately evaluate any supported export or official integration |
| Other social networks | Profile links and explicit share/import workflows | Validate each provider's API, access tier and permitted use before scheduling automatic sync |
| iCloud on the web | Access eligible address books/calendars through the iPhone initially | Separate CardDAV/CalDAV feasibility project if direct web sync is needed; do not assume Sign in with Apple grants this data |
| Other apps | Versioned API and scoped webhooks once internal sync is stable | Shortcuts, Zapier/Make and an optional MCP integration with the same authorization rules |

Google's People API supports contact reads, changes and writes, with version checks for updates and expiring incremental-sync tokens. Build safe full resynchronization rather than relying indefinitely on a cursor. [People API](https://developers.google.com/people/v1/contacts) and [sync-token behavior](https://developers.google.com/people/api/rest/v1/people.connections/list).

Microsoft Graph provides contact delta tracking and calendar-window delta tracking. Store a cursor for each tracked resource; expanding a calendar's date window is an explicit resync operation. [Contact delta](https://learn.microsoft.com/en-us/graph/api/contact-delta?view=graph-rest-1.0) and [calendar delta](https://learn.microsoft.com/en-us/graph/delta-query-events).

LinkedIn restricts its Connections API to approved developers. The existing browser extension is evidence of implemented capture, not proof that ongoing automated extraction is permitted. Keep exports and profile links useful while approval and extension-policy review are unresolved. [LinkedIn Connections API](https://learn.microsoft.com/en-us/linkedin/shared/integrations/people/connections-api).

Meta's Instagram APIs target professional accounts and WhatsApp's Cloud API is a business platform; neither is a foundation for promising a general personal social inbox. Regional/default-messaging facilities on iOS also require separate eligibility analysis. These are conditional research tracks, not dependencies of the core release. [Meta Instagram documentation](https://www.postman.com/meta/instagram/folder/u4g5a2a/instagram-api-with-facebook-login), [Meta WhatsApp documentation](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api), and [Apple carrier-messaging entitlement](https://developer.apple.com/documentation/BundleResources/Entitlements/com.apple.developer.carrier-messaging-app).

### Contact synchronization rules

- Offer Import once, Keep updated and Allow selected updates back as separate choices. Preview the affected people and fields.
- Keep Everclose relationship notes, private reminders, family context and gift ideas private by default. Share only explicitly selected address-book fields.
- User overrides take precedence over incoming fields until the user resets the override. Keep source facts so a later sync cannot erase a deliberate correction.
- Deleting a source contact normally unlinks or marks that source unavailable; it does not delete the Everclose relationship. Revoked permission or a failed fetch must never look like mass deletion.
- Deleting an Everclose contact defaults to Everclose only. Maintain the minimal exclusion needed to stop immediate reimport, with an explicit way to restore it. Account erasure also removes this retained connector state.
- Disconnect offers clear choices about keeping imported facts or removing eligible source-derived data. Confirmed user notes and interactions require separate handling. Retention must also respect the provider's rules.
- A Google address book may already appear in iPhone Contacts. Choose a primary sync route per address book and suppress echo writes; device IDs alone are not cross-device identity.
- Merge, unlink and restore must account for provenance and outgoing operations. Undoing a local merge cannot imply that a remote write has been undone.

Use iOS limited contact access where available and support adding access to more people later. Verify the existing SDK's permission and contact-write behavior on a real device. [Apple limited contact access](https://developer.apple.com/videos/play/wwdc2024/10121/) and [Expo 57 Contacts](https://docs.expo.dev/versions/v57.0.0/sdk/contacts/).

### Calendar synchronization rules

Model external events separately from reminders, plans, birthdays and logged interactions. One event can involve several people. Match attendees by known addresses, hide the user's own identities from suggestions, and review unknown attendees without auto-creating every invitee.

Preserve timezone, all-day dates, recurring-series IDs, occurrence exceptions, cancellations, response status, organizer ownership, conference links and visibility. Start with a proposed 90-day history and 180-day future window, configurable by the user; private events can be represented as busy time without copied details.

Outbound publishing begins with an optional dedicated Everclose calendar. Editing or deleting events elsewhere needs explicit write permission and ownership checks. Show whether an operation will notify invitees. Keep personal CRM notes out of event descriptions by default. If the same event is visible through Google and EventKit, use one primary source and cross-source identity evidence to avoid duplicate reminders or activity.

Webhook notifications trigger an incremental fetch; they are not the event payload or a guarantee of delivery. Renew channels, checkpoint pagination, handle expired cursors and run periodic reconciliation. Retrying a create must reconcile an uncertain provider response before creating another event. [Google Calendar notifications](https://developers.google.com/workspace/calendar/api/guides/push) and [incremental sync](https://developers.google.com/workspace/calendar/api/guides/sync).

On iOS 17+, Apple's event editor supports explicit creation without broad Calendar read access. The installed Expo 57 implementation requires permission on iOS 16. Explicit source verification/reading and editing require full access; the native bridge's device evidence remains open. [EventKit access](https://developer.apple.com/documentation/eventkit/accessing-the-event-store).

### Email and activity rules

Begin with selected folders/labels where the provider and chosen scope support filtering, plus a bounded history window. Store participant identity, date, direction and provider message/thread IDs; avoid bodies and attachments initially, and make subject retention a separate product choice. Gmail's metadata scope has filtering constraints that must be reflected in the setup UI.

Offer two modes: existing people only, or a review inbox for new correspondents. Connecting email before a contact exists retains only the authorized, bounded source index needed for later matching. Creating or linking a contact reruns matching within that retained window; older history requires an explicit provider backfill. Ignore the user's own addresses, bulk/newsletter traffic and automated mail where the evidence supports that classification.

Represent one message with multiple participants rather than duplicating its underlying record. Use provider IDs and, where appropriate, message headers to reconcile copies across accounts. Do not infer closeness or a completed reply from an opened compose window, and do not equate an incoming newsletter with a personal interaction.

Gmail metadata is a restricted scope. A public server-backed product can require OAuth verification and a security assessment even without storing bodies. Assess applicable exceptions for the personal pilot, but do not base public-release timing on them. [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) and [restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

For Gmail, use history checkpoints, repair expired history with a bounded full sync, and renew watch registrations if using Google Pub/Sub push. Validate Pub/Sub requests at the Cloudflare receiver. For Outlook, choose the minimum delegated mail scope that supplies the agreed fields and handle each tracked folder's delta cursor. [Gmail synchronization](https://developers.google.com/workspace/gmail/api/guides/sync), [Gmail push](https://developers.google.com/workspace/gmail/api/guides/push), [Microsoft mail delta](https://learn.microsoft.com/en-us/graph/delta-query-messages), and [Graph permissions](https://learn.microsoft.com/en-us/graph/permissions-reference#mailreadbasic).

## Reminders and relationship intelligence

Complete native local reminder scheduling first, then add server push for changes originating on the web. Coordinate notification IDs and delivery receipts so local and server channels do not deliberately send duplicate alerts for the same occurrence. Cancellation on a disconnected phone is best-effort until it reconnects; show this limit in testing and product behavior.

Add quiet hours, timezone changes, snoozing and per-channel preferences. Native local notifications now use generic lock-screen content and account-scoped routing, with cancellation and rescheduling when accounts change; closed-app device testing and coordinated server delivery remain required. Cloud email activation and automatic backups are separate operational milestones with existing runbooks.

Extend the existing deterministic briefs into pre-meeting context and a weekly review: recent confirmed conversations, open commitments, relevant personal facts and upcoming occasions. Let users choose whether observed email/meeting activity affects check-in timing. Preserve neutral relationship language.

After the connected-data model is stable, add structured relationship search, introductions and optional AI summaries with links to their source records. Let users correct or dismiss suggestions. Treat imported text as untrusted input to any model, keep tools permission-scoped, and require explicit action before messaging someone. Voice notes, business-card OCR, maps, widgets and Shortcuts follow measured usage needs rather than blocking sync.

## Delivery milestones

The effort ranges below are planning estimates for one experienced full-time engineer with regular product review and access to QA/device testing. They are not elapsed-time commitments. Provider reviews, security assessments, Apple account setup and commercial decisions are external dependencies. Re-estimate after the foundation design and first vertical slice.

| Milestone | Scope and dependencies | Completion evidence | Indicative effort |
| --- | --- | --- | --- |
| 0 Working baseline | Finish real local OAuth, staging isolation, release inventory, dependency triage, recovery drill for the supported dataset; start provider/Apple registration | Real sign-in; staging smoke journey; contacts export and verified restore; documented enabled/disabled capabilities | 1–2 engineer-weeks |
| 1 Identity and sync service | Add contact methods, public IDs, source links, provenance, device sessions, versioned push/pull, tombstones, merge aliases and restore epochs | Web edit reaches a replica; offline edit returns once; conflicts and stale devices preserve user data; cross-workspace access is rejected | 3–5 engineer-weeks |
| 2 Mobile daily product | Depends on 1; native sign-in and first-sync migration, People/Today/profile/agenda/capture, local reminders, draft handling and mobile web improvements | Real iPhone/TestFlight journey from capture through web sync and closed-app reminder; offline restart and permission-denied paths pass | 3–5 engineer-weeks |
| 3 Connected address books and LinkedIn | Depends on 1 and native shell; Google and iPhone inbound sync and link review; LinkedIn profile links and export import, with existing capture enabled only after its access/policy review; optional contact write-back follows the personal beta | Import before creation and link after creation both work; repeated sync, conflicts, provider deletion and duplicate address books cause no silent loss; LinkedIn context attaches to the same person | 2–4 engineer-weeks |
| 4 Connected calendars | Depends on 1; Google calendar adapter, Apple event bridge, attendee linking, plan publishing and renewal jobs | Event changes and cancellations converge; recurrence/DST tests pass; retry causes no duplicate event or unwanted invitation | 2–4 engineer-weeks |
| 5 Email context | Depends on identity/connector jobs and approved access; Gmail metadata, bounded backfill, correspondence review and activity dedupe | Existing and subsequently created people get correct history; revoke/reconnect and expired-history repair work; unwanted mail stays out | 2–4 engineer-weeks |
| 6 Intelligence and public release | Depends on the personal beta; better briefs/search, native share extension, delivery operations, large-workspace release limits, accessibility/performance, account deletion, privacy disclosures and App Store submission | End-to-end release gates below pass; share-to-existing-person works; operational ownership and support are ready | 3–5 engineer-weeks |
| 7 Broader connections | Microsoft contacts/calendar/mail, additional permitted social capture, scoped API/webhooks and automation tools; can overlap public-release preparation if resourced | A second provider uses the same lifecycle and matching model; scopes and limits are accurately shown | 3–5 engineer-weeks |

The original indicative engineering scope is 13–24 engineer-weeks through the integrated personal beta, 16–29 through public release, and 19–34 including broader connections, before contingency and external review delays. These totals describe the full milestone scope; they are not estimates of remaining work after the local foundations already implemented. Re-estimate remaining effort after the real first-sync journey. Reserve roughly 25% contingency until the sync and provider spikes resolve the largest unknowns. Additional engineers can overlap mobile UI, connector work and QA after the shared contracts stabilize; calendar duration will not shrink linearly with headcount.

Milestones 0–2 produce a useful mobile alpha for personal testing; milestone 3 begins connected contact testing. The requested integrated personal beta is milestones 0–5: web and native iOS sharing data, Google and iPhone contacts, LinkedIn linking/import, calendar events and Gmail context where access is authorized. Milestone 6 prepares public release; Microsoft is not a dependency. Do not let an inaccessible social API hold the core product indefinitely.

### Next implementation priorities

All six core record types, recovery epochs, revocable device sessions and native reconciliation already have local implementations, including offline agenda/context editing and durable merged identities. They still need real authenticated/device verification. The next engineering work extends that foundation rather than rebuilding it.

| Order | Deliverable | Concrete acceptance |
| --- | --- | --- |
| 1 | Finish the real development and staging baseline | Google login succeeds; staging has isolated storage; a verified copy of the owner's existing relationships restores without replacing production data; enabled capabilities are documented |
| 2 | Verify phone sign-in, first sync and account continuity | Existing web records appear in the correct iPhone cache; earlier local-only records have an explicit import review; reconnect, expired sessions and account switching show truthful states |
| 3 | Validate the implemented version-4 phone/cloud service on devices | Offline edits survive restart and arrive once on web; conflicts and restoration preserve drafts; older protocol versions remain compatible; a reminder fires with the app closed |
| 4 | Finish mobile People, profiles, Today and agenda | Pagination reaches the whole supported directory; photos and relationship context are available; forms retain drafts; essential actions pass small-screen, larger-text and VoiceOver checks on mobile web and iPhone |
| 5 | Validate and harden the implemented Google Contacts inbound slice | Real consent, reviewed create/attach, source-first and create-first journeys, recurring updates, sticky corrections, missing sources and revocation preserve the same relationships |
| 6 | Validate iPhone reconciliation and LinkedIn import; complete shared source availability | Limited access works on device; the same Google/iPhone person stays one relationship; actual LinkedIn exports create or attach without duplicates; permission/unavailability states remain truthful across devices |
| 7 | Validate and harden the implemented selected-calendar event reads | Real accounts confirm the locally verified bounded publication, timezones, all-day dates, recurring exceptions, cancellations and private visibility; failed or revoked reads retain CRM history |
| 8 | Validate implemented event context and link editing on web and iPhone | One event supports several people; matches require review; a plan can attach to an existing event; saved links survive merges, offline reads and recovery; recurring jobs expose freshness and failure |
| 9 | Validate implemented Google publishing and the native Apple bridge; complete shared Apple context and cross-source coordination | Real-account publishing confirms reviewed guest effects, original-event reconciliation and version-protected updates; the Apple bridge saves through the system editor; opt-in source following changes only the plan date and stops on manual correction or removal |
| 10 | Add Gmail context for the personal account | Scope and pilot eligibility are confirmed first; bounded metadata appears for existing and later-created people; own addresses, ambiguous matches and bulk mail are handled; reconnect and expired-history repair preserve saved relationships |
| 11 | Run the integrated personal beta and prepare public distribution | The owner completes the week of daily use above; observed defects are resolved; then provider approval, public account/deletion flows, Sign in with Apple, App Store distribution, monitored delivery and recovery pass their release checks |

Run an environment track alongside those changes: complete real Google development OAuth; prepare staging and a supported native toolchain/build; verify production account/data continuity and migration inventory; triage dependencies; and test export/restore. The installed Xcode version recorded by the mobile setup is below Expo 57's required 26.4+, so either update the local toolchain or use a compatible managed build environment before native validation. [Expo 57 requirements](https://docs.expo.dev/versions/v57.0.0/). Credentials and toolchain setup block live validation, but independent implementation and disposable tests can continue.

Keep these as small reviewable changes. Each feature includes migrations, capability reporting, recovery/erasure implications and relevant tests. Create GitHub issues and release assignments only when implementation is scheduled; this plan does not create or modify external issues.

Consented recurring Calendar jobs and rolling-window/backfill repair now have local implementations, preserving reviewed people/plan links and private relationship data. Automatic downloads are off by default, enabled per selected calendar, bounded to the confirmed window and fenced against changed consent, expiry and recovery. Reviewed Google plan publishing and conditional updates also have locally verified implementations, including invitation-effect review and original-event reconciliation; actual Google account evidence is still required. Native association editing, its durable link-only outbox, explicit choices and uncertain-response recovery support retained Calendar context offline through protocol 4. The native Apple system-editor bridge now has a local schema-14 implementation: creation, full-access verification and default-off date following are separate actions, and an attempted creation is never repeated automatically. Its event facts/receipts remain on the choosing phone; cloud sharing, arbitrary selected Apple event reading, Google/EventKit identity coordination and a distributed plan reservation against concurrent publication remain engineering gates. [Apple Calendar runbook](apple-calendar.md) records these limits and physical-device checks. The next independent engineering work adds Gmail context using the shared activity model. The real OAuth, staging and supported native-build/device track continues alongside it. Calendar integration is not complete until real web/iPhone journeys, recurring delivery, source coordination and publishing pass their checks; no deployment or completed personal beta is implied.

## Verification and operating requirements

### Required journeys

- Manual contact → connect Google → link same person → attach iPhone record → preserve private notes and all activities.
- Source-first import → later CRM edit → provider edit → conflict review → correct result on web and two devices.
- Offline capture → app termination → restart → reconnect → retry after lost acknowledgement → exactly one CRM mutation effect.
- Same address book through Google and iPhone → one identity and no write loop.
- Revoke a scope or remove limited Contacts access → visible permission state without a mass delete.
- Delete, merge and restore while a device is offline → no resurrection or silent overwrite; external writes remain paused until reconciled.
- Calendar recurring event, exception, all-day birthday, DST move and cancellation → correct agenda and reminders.
- Lost provider-create response → reconcile before retry; no duplicate event/contact and no surprise invite.
- Email connected before contact creation → later link → bounded authorized history appears once, including shared-address ambiguity.
- Account switch, logout, disconnect and full deletion → no data leaks between users and no surviving unauthorized sync jobs.
- Real iPhone background, force-quit, denied permissions, expired session and network outage → truthful status and usable local data.

Use unit tests for identity and conflict rules; disposable D1/R2/Queue integration tests for transactions and recovery; provider contract fixtures plus controlled real accounts for API behavior; Safari/desktop browser journeys; and physical-device tests for native APIs. Test backup, export and erasure coverage whenever a new table or object type is added. Fault injection must cover duplicate/out-of-order webhooks, pagination interruption, token expiry, rate limits and unknown write results.

### Proposed service targets

These are acceptance targets to validate, not claims about current performance: a common mobile capture should take under 20 seconds; a simple local search should feel immediate, targeting p95 below 200 ms on the agreed baseline iPhone; ordinary online device edits should appear on another foreground client within 10 seconds; incoming provider changes should generally arrive within 15 minutes where the provider supports that cadence. Show exceptions and last-success timestamps rather than claiming real-time sync.

Measure initial sync and everyday actions with at least 10,000 contacts and a bounded 100,000-activity test dataset. Record the supported limits before widening imports. Add sync success rate, queue age, retry/dead-letter count, webhook renewal failures, recovery lag, native crash rate and cost per active workspace to operational dashboards. Logs must contain identifiers and failure categories without private contact or message content.

Track product outcomes separately: time to first useful contact set, weekly use on both devices, reminders acted on, manual corrections caused by bad matching, and time spent maintaining data. A high import count is not proof the product is useful.

### Public release gate

Ship only the connectors and dataset sizes that pass their checks. Require a real authenticated web/iPhone journey, a restore drill, observable background work, acceptable dependency triage, account deletion and credential revocation, documented retention, provider approval where needed, and appropriate App Store permissions/disclosures. Specify support and incident ownership and an operational budget before opening registration broadly.

Improved briefs, AI features, widgets and broader integrations are optional product improvements. Public readiness is judged by the advertised core behavior and the operating requirements above; these optional features do not become extra release gates.

Resolve the existing 16 MB interactive-recovery boundary and birthday-delivery merge restrictions for the advertised release scope. Either complete and validate advanced recovery at that scope or state and enforce the supported limits. Automatic backup, email and large-recovery flags are activated independently with their runbooks, not because a build succeeds.

Cloud synchronization uses server-readable data unless a separate end-to-end encryption architecture is designed. Preserve encrypted portable exports, but do not describe server-side email ingestion or cloud backups as end-to-end encrypted. Device database encryption and key recovery must be designed and tested together; losing a key must have an explicit recovery story.

The main operating cost drivers are Cloudflare database/storage/queue usage, logs, push/email services, Apple distribution, and potentially Google's restricted-scope assessment. Optional AI and enrichment require separate cost limits. Collect current quotes and account limits during milestone 0 rather than inventing a fixed budget here.

## Decisions to confirm as work is scheduled

The Gmail source implementation now has a dedicated metadata-only consent purpose,
encrypted credential lifecycle and explicit mailbox-label preview, with D1-tested
ownership/recovery/revocation fences and preservation of prior records in migration
45. This is a consent/preview milestone: real client configuration, durable message
staging, reviewed matching and web/iPhone relationship context remain required.
Production still has migration 44; personal iOS build 4 is signed and installed,
with native startup verified and physical UI/data confirmation pending the
owner unlocking the phone. See [Gmail implementation](gmail.md) and the
[personal iOS release record](personal-ios-release.md).

The provider and audience choices are confirmed: Google Contacts, Gmail, Google Calendar, iPhone Contacts and LinkedIn, for personal use first and a public release later. Use the personal-beta defaults above for planning, then adjust them from actual usage. Set the operating budget and service limits before activating recurring provider jobs or opening public registration. The proposed native stack remains Expo/React Native; a full SwiftUI rewrite, Android, direct iCloud access and team sharing are separate scope decisions. Broad email-content ingestion, autonomous outreach, sales campaigns and universal social-history synchronization are outside the initial release.

The immediate release gates are real development OAuth and a supported native build/device journey. Continue independent work on shared source availability, calendar integration and mobile account usability while those gates are completed. LinkedIn export import is implemented locally and still needs an actual-owner export and authenticated staging/device validation. The existing sync and Google source foundations support the calendar and Gmail slices that follow.
