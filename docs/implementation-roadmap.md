# Everclose Implementation Roadmap

Objective: implement the engineering and product sequence in `audit-2026-09-04.md`, preserving the personal relationship companion concept.

## Release Gates

- [ ] Trust: recoverable deletion and tested tenant-scoped restoration; correct backup retention and complete erasure.
- [ ] Trust: atomic replay protection and conflict detection across cloud writes; exactly-once completion and accurate interaction history.
- [ ] Trust: cloud dashboard, briefs, search, filters, calendar, and birthday calculations match the product contract.
- [ ] Trust: bounded, resumable imports with preview, reconciliation, duplicate review, and export round-trip coverage.
- [ ] Trust: dependency triage, production build, cloud-runtime tests, tenant isolation, and truthful capabilities/privacy copy.
- [ ] Daily experience: Today with useful context and Reach Out / Log / Snooze actions, deduplicated per person.
- [ ] Daily experience: streamlined navigation, mobile directory and profiles, agenda calendar, progressive quick capture, and small-circle onboarding.
- [ ] Reminders: server scheduling and closed-app delivery, timezone handling, snoozing, quiet hours, preferences, and delivery monitoring.
- [ ] Reduced maintenance: consent-based calendar/contact integrations with provenance and shared authenticated web/iOS data.
- [ ] Source-grounded intelligence: useful deterministic briefs first, then optional reviewable assistance tied to stored facts; no autonomous outreach.
- [ ] Product quality: inclusive relationship/family model, neutral relationship status, accessibility, responsive visual QA, and meaningful outcome measurements.
- [ ] Release: verify each gate against current source and runtime evidence; deploy only a verified candidate and document any external configuration needed.

## Work Log

### 2026-09-04

- Revalidated the audit against the current working tree. Existing changes are preserved.
- Implemented durable, workspace-scoped replay receipts for contacts, interactions, reminders, plans, children, and relationships. Receipt and resource writes share one D1 transaction; mismatched keys and retries after deletion fail safely.
- Added atomic snapshot comparisons for contact and interaction edits. History responses now carry the interaction revision required by the editor.
- Made plan/reminder completion conditional and exactly-once. Completed reminders no longer return in the default open queue.
- Added database triggers to keep last-contacted dates accurate after interaction inserts, edits, and deletes, and to prevent duplicate reciprocal relationship pairs.
- Added bounded JSON parsing to cloud contact/core writes, and awaited dispatch calls so asynchronous validation errors reach the intended response handlers.
- Added seven behavioral regression tests, runnable against both a disposable SQLite adapter and a local Cloudflare D1 runtime. Wired `npm run test:cloud` into CI and pinned its Miniflare development dependency.
- Verified: 203/203 tests, lint, and TypeScript checks pass. `npm run test:cloud` passes 9/9 tests (seven behavioral tests plus two existing cloud configuration checks) using the finalized migrations.
- Added generated migration `0001_cloud_mutation_receipts.sql` and custom migration `0002_cloud_write_triggers.sql`, including Drizzle metadata. Apply both before deploying the updated cloud write handlers. Neither migration nor application changes have been deployed.
- Next: implement consistent recovery snapshots and safe restoration, retention and complete erasure. Keep receipts private and account for their lifecycle during restore/erasure. Then finish cloud calculations/import parity before the Today/mobile redesign.

The broad write-safety gate is still open: bulk tag races, other editable resources, and the full cloud route contract need further coverage. Production build and full browser journeys have not yet been run for this implementation milestone.

### Recovery Milestone

- Revalidated the previous milestone against disk. The previous goal turn made implementation progress; no background work was assumed to be running.
- Added transactional workspace recovery revisions, database guards, backup-file state, and pins that prevent deletion/retention from removing recovery files used by an operation.
- Cloud contact and bulk deletion now require a schema-validated, stored, checksum-verified snapshot. A workspace edit during snapshot persistence causes the destructive transaction to abort rather than bypass recovery. Bulk deletion uses one JSON binding instead of exceeding D1's parameter limit.
- Implemented managed and uploaded cloud JSON restoration. It validates tenant ownership, table/column types, IDs, graph references, and managed-file checksums; preserves the current state first; restores all CRM tables atomically; and invalidates old create receipts without allowing silent replay into a different restored record.
- Added complete R2 listing pagination and retention of 20 backups, preserving the newest checkpoint of each kind and any additional in-use snapshots. Pins prevent races with manual deletion.
- Added resumable workspace erasure with durable object-key batches and a write-blocked lifecycle. An interrupted storage deletion returns failure/pending rather than success, and the Settings screen continues pending requests or offers resumption.
- Corrected cloud recovery copy, accepted upload formats, protected-backup controls, checksum verification before encrypted download, and the distinction between CRM erasure and Google identity/billing/operator recovery copies.
- Added migrations 0003 through 0005 and their generated metadata. No remote migration or deployment has been performed.
- Added seven recovery regression tests covering graph round trips, restoration undo, foreign/corrupt files, rollback, storage outages, concurrent edits, retention/pagination, oversized snapshots, 120-contact bulk deletion, and resumed erasure.
- Verification: 210/210 tests, lint, and TypeScript checks pass. All 16 cloud-runtime checks pass against disposable D1 and R2, including the expanded recovery cases. Earlier cloud-runtime checks caught a D1 compound-select limit; the query was corrected to scalar sums. No authenticated browser journey or production build has been run for this milestone.

The recovery release gate is not complete yet. Interactive snapshots/restoration deliberately stop at 16 MB without changing CRM data; larger workspaces still need the planned streaming/background job path. Abandoned operation pins need a fenced cancellation/recovery workflow, failed backup objects need cleanup, and scheduled cloud backups are not enabled. Confirm the deployed Workers plan/query budget, verify authenticated browser recovery journeys, and run production builds before release. Do not treat the bounded implementation or green unit tests as completion of the larger recovery objective.

An unchecked gate remains part of the objective. Passing existing tests alone does not establish completion.

### Cloud Product Milestone

- Revalidated the latest audit against current source and disposable cloud-handler reproductions. The previous goal turn yielded actionable evidence, including lost concurrent tag changes and birthday context hidden during feed deduplication; it was progress, not a blocked or waiting turn.
- Connected cloud overview and smart-list routes to the shared relationship calculations. Reads use a consistent batch and project signal fields rather than contact photos or full interaction histories. Manual company/location fields now take precedence over imported context.
- Added cloud profile briefs based on actual history and open reminders, plus fully paginated timelines. Open reminder/plan panels exclude completed tasks, which remain visible in the timeline/history where supported.
- Implemented exact cloud tag filters and literal search across names, contact methods, notes, how-we-met, and stored custom-field text values. Searches no longer rely on D1's small LIKE-pattern limit or match JSON property names as facts.
- Made bulk tag mutations atomic in SQL, supporting 500-person selections without per-ID bind overflow. Missing/foreign contacts and tag-capacity failures do not partly change a selection. Actual returned contact IDs, rather than D1's trigger-inclusive mutation count, determine the affected count.
- Added shared civil-date helpers and wired client timezones through dashboard, smart lists, profile briefs, and birthday notification requests. Cloud calendar queries use exact local-day UTC boundaries, including DST changes, with a 5,000-event response limit and truthful truncation. Contact/child leap birthdays use March 1 in non-leap years in both calendar backends.
- Implemented cloud birthday notification candidates honoring each contact's lead time and local date. This fixes open-app notification eligibility, not closed-app delivery; durable delivery remains a separate gate.
- Deduplicated feed suggestions retain structured reason titles, dates, and reminder IDs. The dashboard displays secondary reasons, so a check-in suggestion cannot hide an upcoming birthday or explicit reminder. The broader Today action UI is not implemented yet.
- Added seven cloud product regression tests, two civil-date tests, and a combined-suggestion regression. Fixed the stale neutral-headline expectation. Verification: 220/220 tests, lint, TypeScript, and diff checks pass. The 23-test cloud suite passed after the trigger-count correction; all seven product tests passed again against the local Cloudflare runtime after the final tag-capacity safeguard and date-formatter changes.

This milestone does not close the broad cloud-parity/release gate. The legacy stats endpoint still has placeholders, capability-driven UI and cloud import reconciliation remain unfinished, and large-workspace payload/CPU budgets need explicit testing. Full browser verification and production/cloud builds remain pending. No remote migration or deployment was performed. Next: finish these trust gaps before the Today/mobile redesign, then durable reminders, consented integrations/shared iOS data, grounded assistance, and the remaining release gates above.

### 2026-10-01: Cloud Import Journey

- Classified the previous audit turn as progress: it produced reproducible evidence that changed the next action. Revalidated the working tree rather than assuming earlier recommendations were already implemented. The roadmap's full scope and unchecked gates remain intact.
- Connected cloud CSV, vCard, and selected-phone-contact uploads to the staged import engine. Uncertain upload retries retain their request key and file while the screen remains open, and successful uploads navigate to the saved preview instead of claiming an immediate import count.
- Added import history and per-job reports with row outcomes, filters, pagination, explicit duplicate decisions, existing-contact and same-file match context, confirmation, bounded processing, pause/resume, cancellation, original download, and report removal. Existing contacts are never overwritten by this import flow.
- Processing is request-driven, not a background scheduler. The interface explicitly explains that a page must be running to advance a job, that one in-flight batch may finish after leaving, and that saved progress can be resumed. Errors require a refresh before resuming, rather than falsely reporting a failed response as unsaved data.
- Original files and normalized rows are stored transactionally in segmented D1 records, bounded to 20 reports and 50 MB of source files per workspace. Retention and backup exclusions are explained in the UI. Removing a report removes its original and staged rows but preserves imported contacts. Restore cancels old pending imports; erasure removes their jobs, rows, and sources.
- Removed the unused legacy cloud import loop and fixed the preview date-normalization type errors. Corrected first-run processing/privacy wording and the CSV capability description.
- Added six behavioral tests covering reconciliation, duplicate choices, retries/concurrent advancement, cross-workspace reads, rollback on storage failure, post-preview matches, multi-segment source downloads, bounds, vCard fields, restore/cancellation, and erasure. All 29 cloud tests pass against disposable Cloudflare D1/R2. The full unit suite passes 226/226; TypeScript, lint, and diff checks pass.
- Added three browser scenarios exercised at desktop and mobile sizes: duplicate review through removal, recovery from a lost advancement response, and upload retry using the same saved job. All six runs pass. These use actual import handlers/migrations with disposable SQL storage at an intercepted HTTP boundary; they do not certify deployed middleware, Google OAuth, or production bindings. The upload scenario requires a preview with NEXT_PUBLIC_AUTH_MODE=google and BONDS_E2E_CLOUD_UI=true. BONDS_E2E_BROWSER_CHANNEL=chrome supports installed Chrome when bundled Chromium is unavailable.
- Inspected desktop/mobile preview screenshots and passed automated accessibility checks on the filtered report. Fixed the filter's explicit label association during browser verification. A local 5,000-row preview completed in 50 batches, with 5,000 ready and no missing rows (about 22 seconds of preview work in the SQLite harness); this is not a production Worker CPU benchmark.
- The standalone production build succeeds and verifies that no database or environment files are packaged. It emits dependency Edge Runtime warnings concerning jose compression APIs, which still need compatibility triage. Migration 0006 is required before deploying the import changes; no remote migration or deployment was performed.
- The Google-auth Cloudflare build also succeeds, producing the OpenNext Worker bundle after its own type/lint checks and standalone packaging verification. Both builds were run after implementation; successful bundling does not prove live OAuth or deployed import behavior.

This milestone does not close the full import/export or release gate. Complete exports beyond 10,000 contacts, all-field export/import round trips, production-scale CPU/memory/storage quotas, deployed authenticated journeys, dependency triage, capability-driven controls, and the remaining recovery work are still required. Continue with those trust gaps, then the Today/mobile redesign and all later gates above; do not treat the import screens or green tests as completion of the overall objective.

### 2026-10-01: Contact Export Fidelity

- Rechecked the cloud and local contact exporters against both import paths. CSV files now carry photo URLs and custom fields; cloud preview and local CSV import parse and validate the custom-field JSON rather than ignoring or rejecting it as raw text.
- vCard export now includes remote photo URLs and an Everclose-specific custom-field property. Re-importing that property preserves the stored custom fields instead of replacing them with generic import metadata. Other vCard readers may ignore this vendor property; it is not a full-workspace backup format.
- Cloud exports now query one extra row and return an explicit non-download response when a workspace exceeds 10,000 contacts. Previously, the route silently returned only the first 10,000. The contacts screen surfaces this limit when its displayed count exceeds it, and explains that contact downloads omit relationships, history, and reminders. Success responses use no-store cache headers and Everclose filenames.
- Added cloud-handler tests for field round trips, tenant isolation, and the 10,001-contact failure boundary. Verified 229/229 unit tests, 31/31 disposable Cloudflare-runtime tests, lint, TypeScript, diff checks, and the standalone production build. The build still emits the existing `jose` Edge Runtime warnings; live Google auth and deployed behavior remain unverified.

The import/export gate is still open. A complete large-workspace export needs a bounded multi-request or background design, not a larger in-memory D1 result. CSV and vCard downloads are contact-only and do not preserve all metadata (for example original creation timestamps), while cloud import remains limited to 5,000 rows and 10 MB per upload. Production memory/CPU behavior and round-trip browser journeys still need verification. No remote migration or deployment was performed for this milestone.

### 2026-10-01: Resumable Cloud Contact Exports

- Replaced the size-limited direct cloud contact downloads with workspace-scoped CSV/vCard export jobs. Each advancement reads at most 25 contacts, saves a cursor and recovery revision, and assembles the output in private R2 multipart storage. A workspace edit invalidates an unfinished export instead of presenting a misleading file. The old direct cloud routes now fail safely and point to the job flow.
- Added a contact exports page with saved progress, explicit resume, a ready-file download link, and resumable removal. Downloads are available for six days; files are **not** automatically purged at expiry, and the UI says they remain until removal or workspace erasure. The job limit is three per workspace.
- Added migration `0007_lame_maverick.sql` for durable job state. This migration must be applied before this code is deployed. No remote migration or deployment was performed.
- Tested cursor resumption, idempotent creation, storage outage retries, revision changes during multipart completion, tenant isolation, removal/erasure, files crossing the R2 multipart boundary, and a 10,001-contact export. The large count ran in the SQLite harness; the Cloudflare runtime suite covered the R2 behavior at smaller counts. All unit tests, 39 Cloudflare-runtime tests (one large-count skip), lint, TypeScript, diff checks, and the Cloudflare production build pass.
- Desktop and mobile browser tests pass for preparing a job, showing its download link, and removing it; the handler test verifies downloaded bytes and headers. The browser tests intercept export HTTP requests with disposable storage and do not prove a native download through deployed middleware, live Google OAuth, or production D1/R2 bindings. A pure route-map test now covers the cloud download rewrite, and the service worker no longer intercepts API navigations.

The import/export and release gates remain open. Contact files omit relationship graphs, children, history, plans, reminders, and some metadata; cloud import still caps uploads at 5,000 rows and 10 MB. Add automatic retention cleanup, production-scale quota/concurrency testing, deployed authenticated download and round-trip journeys, and the remaining recovery/capability work before release. Then continue with the Today/mobile, reminder, integration, intelligence, and quality gates above.

### 2026-10-01: Scheduled Export Retention

- Added a custom OpenNext Worker entry that keeps the app's fetch handler and adds a Cloudflare Cron Trigger every 15 minutes. Each run checks at most 10 expired or partially deleted jobs across workspaces, skips live leases, removes their R2 objects and D1 rows, and retries incomplete cleanup later. Per-job storage failures are logged and moved behind untouched jobs so one bad file cannot indefinitely monopolize the sweep.
- Completed exports clear their multipart upload ID before object deletion, making a retry safe if a later database operation fails. The export page now explains that downloads expire after six days and that expired files are scheduled for removal, while still allowing earlier manual removal.
- Added the retention query index in migration `0008_chubby_red_skull.sql`; apply migrations 0007 and 0008 before deploying this Worker. Both the OpenNext build and Wrangler dry-run bundle succeed, and the bundled Worker contains the scheduled handler. The disposable Cloudflare D1/R2 suite passes 41 tests with one large-count skip, including expiration, tenant isolation, partial deletion, storage failure, and lease cases. No remote migration, deployment, or live Cron invocation has occurred.

Automatic retention is implemented but not operationally verified. After a verified deployment, confirm Cron invocations and cleanup lag in Worker logs, plus a real authenticated download. The full release gates above remain open; in particular, production-scale quotas/concurrency, cloud import/export round trips, large recovery jobs, and the daily product experience still need work.

### 2026-10-01: Today Action Journey

- Replaced the dashboard's passive feed with a Today queue showing the actual reminder, birthday, or check-in reason, other reasons for the same person, and the latest logged conversation. Reach Out opens contact methods without pretending that outreach happened; Log records a dated moment; Snooze hides only the chosen reason and can be undone.
- Added durable, reason-specific snoozes to local SQLite and tenant-scoped cloud D1. Active snoozes affect the daily queue and overdue check-in signals without completing reminders or changing history. Cloud backups/restores and workspace erasure include the new table; older backup versions restore with an empty snooze set.
- Fixed a ranking defect where snoozed candidates consumed the limited reminder or birthday slots, hiding other due people. Both local and cloud reminder queries now select past active snoozes before applying limits.
- Made Today refresh at the next local day and after a long-hidden tab returns, without replacing already loaded content with a full skeleton. Tightened the empty smart-list state and explained safe retries after an uncertain log response.
- Added migration `0009_true_medusa.sql` with tenant, erasure, and recovery-revision guards. Apply it before deploying this code. No remote migration or deployment was performed.
- Verification: full local unit suite, TypeScript, lint, Cloudflare build, and Wrangler dry-run pass. The Cloudflare D1/R2 integration suite passes 42 tests with one intentional large-count skip. Desktop and mobile browser journeys pass Reach Out, Snooze/Undo, idempotent Log retry, accessibility checks, and horizontal-overflow checks. Browser tests use real handlers with disposable storage behind an intercepted HTTP/auth boundary; they do not certify live Google OAuth or deployed middleware.

The broader daily-experience and release gates remain open. Next priorities include explicit reminder completion from Today, wider mobile profile/calendar QA, closed-app delivery with preferences, production-scale quotas, and a staged authenticated deployment check. Avoid calling this ready for all users until those trust and release gates are verified.

### 2026-10-02: Today Follow-Through

- Added an explicit Mark done action for reminder-led Today cards. It calls the existing conditional completion endpoint, supports retry after an uncertain response, and does not invent an interaction; logging a conversation remains a separate action.
- Changed local and cloud candidate queries to pick the earliest active reminder per person before limiting the queue. Several overdue reminders for one contact can no longer crowd a second person out. Completing the first task reveals that person's next task, and an independent birthday still appears after all their tasks are completed.
- Replaced ambiguous numeric due dates in Today with readable dates and an explicit overdue label. Success notifications now replace older ones and keep mobile side margins, avoiding a stack that obscures the card.
- Verified the new ranking in pure feed tests, local SQLite, and disposable Cloudflare D1. The full local unit suite and Cloudflare D1/R2 suite pass; the latter has 43 passes and one intentional large-count skip. The desktop/mobile browser journey passes logging, snooze/undo, lost-response completion retry, accessibility, and overflow checks. The Cloudflare production build succeeds on the final application source and excludes database and environment files from the standalone package.

This is still a local milestone, not a release claim. No remote migration or deployment has occurred. The remaining roadmap gates, especially closed-app reminders, mobile profile/calendar QA, large-workspace performance, live OAuth, and staged deployment verification, remain open.

### 2026-10-02: People-First Directory and Profile

- Removed the percentage relationship-health formula and its Healthy/Neglected grades from the web directory and profile. They could label a person neglected before the chosen cadence was due and treated missing history as perfect health. Both views now show neutral timing states derived from civil dates and the contact's check-in preference, with an explicit unknown state when nothing is logged.
- Put labelled Log moment and Reminder actions in the profile header. Log opens and scrolls to the existing interaction form on mobile; Edit and Delete remain available in a compact More menu. The profile explains that the cadence is a reminder preference, not a measure of relationship quality.
- Hid the directory's bulk-delete panel and selection checkboxes until an explicit Select people mode. Moved cleanup, transfer, import reports, and exports into a Manage menu, so search and contact cards appear earlier on a phone. Upload errors remain visible outside that menu.
- Updated the README and added pure timing tests covering unknown history, cadence boundaries, future dates, and DST-adjacent civil dates. The full local unit suite, TypeScript, lint, and Cloudflare production build pass. Desktop and mobile browser journeys use disposable cloud handlers and pass directory grid/list, Select and Manage menus, profile quick capture, accessibility, and overflow checks. Screenshots were inspected for the mobile directory, profile header, and interaction form.

This closes neither the broad mobile-experience gate nor the release gate. The calendar still needs mobile agenda-first/actionable-event work, the profile still has a long single-page history below the quick action, and deployed OAuth, quotas, and closed-app reminders remain unverified. No remote migration or deployment was performed.

### 2026-10-02: Actionable Calendar

- Phones now open the agenda by default; the month/agenda choice and event filters persist locally. Filters collapse on small screens so the current month and events appear sooner. A selected contact remains visible in the filter control even in a month without their events.
- The calendar can create a reminder for the selected day or from the header using a searchable contact picker. An uncertain create response retains the same idempotency key for a safe retry. Reminders and plans can be marked done from event cards; plan completion explicitly reports that it adds a history entry.
- Completed event cards no longer fade their text. Dashed borders and strike-through convey completion without reducing contrast. The desktop/mobile browser journey covers creation with a lost response, exactly-once retry, completion semantics, saved filters, accessibility, and horizontal overflow; screenshots were inspected.
- The Cloudflare production build passes after these changes. No remote migration or deployment was performed.

The calendar improvement does not close the daily-experience or release gates. Direct event editing/rescheduling, larger mobile profile simplification, closed-app reminders, and live authenticated deployment checks remain open.

### 2026-10-02: Mobile Profile Focus

- Compacted the mobile identity card so the person, quick actions, section switcher, and relationship brief are visible much sooner. The action bar stays available while scrolling, with direct Message/Email where a contact method exists, Log moment, Reminder, and an overflow menu for edit/delete.
- Added mobile Overview, Activity, and Details sections instead of stacking every profile workflow. Activity offers separate All activity and Conversations views, avoiding a duplicate stack while preserving the existing editable interaction log. Header Log opens the Conversations view and scrolls to its form. Family, children, memory, social links, and tags remain reachable in Details; desktop continues to show the full profile layout.
- The desktop/mobile browser journey verifies section visibility, quick capture, relocated details, sticky actions, accessibility, and horizontal overflow. The Cloudflare production build, TypeScript, and lint pass on this source. No remote migration or deployment was performed.

This improves the profile journey but does not yet merge chronology and editable conversations into one source-backed, filterable history. Progressive contact creation, closed-app reminder delivery, live OAuth/runtime checks, and the other release gates remain open.

### 2026-10-02: Progressive Contact Creation

- Reduced the initial form to a name, optional contact methods, and a note. Additional identity, work, social, birthday, context, and cadence fields are revealed only when requested. A sticky Add contact action remains within the mobile viewport.
- Added opt-in, 24-hour, tab-local draft recovery. Drafts are keyed to a verified account, exclude photos, and are cleared on discard, successful save, or sign-out. If the account cannot be verified, draft recovery stays unavailable while ordinary contact creation still works.
- Retained both the idempotency key and exact request body after an uncertain save. Retrying cannot silently turn a changed form into a second contact; the user is told when the earlier save was confirmed and later edits were not applied.
- Added desktop/mobile cloud-mode browser coverage for progressive fields, account switching, draft restoration, lost-response reconciliation, accessibility, and overflow; both checks pass on the final Cloudflare build. Updated local-auth browser coverage for the new form and profile actions; its four focused desktop/mobile checks pass. The full local unit suite, TypeScript, lint, local production build, Cloudflare production build, and standalone output checks pass. A missing favicon request exposed by strict browser-console checking is now served through the app icon.

This is not a deployment or a completion claim for the broader daily-experience gate. Drafts are intentionally limited to one tab and omit photos; they are not synced across devices. The browser journeys use disposable test storage, not live Google OAuth or deployed D1/R2. Closed-app reminders, larger-scale runtime checks, and the other release gates remain open.

### 2026-10-02: Clear Navigation and Global Capture

- Consolidated the primary desktop and mobile navigation to Today, People, Calendar, and Settings, with a consistent Add control. People now exposes Groups and Smart Lists as secondary destinations; Calendar exposes Reminders; Settings exposes Integrations. Existing URLs and data models remain unchanged.
- The Add menu opens real flows for a new person, a logged moment, and a reminder. Moment capture asks for a person before opening that profile's conversation form; reminder capture opens the calendar form on the current day, focuses its title, and scrolls it into view on phones. Nothing is logged merely by opening either flow.
- Made the reminder person picker show a truthful loading state instead of prematurely saying there are no matches. Darkened the active desktop navigation label to preserve WCAG AA contrast over the translucent header when colored content scrolls beneath it. The Add menu supports Escape, returns focus, and keeps its controlled panel addressable while closed.
- Verified the full local unit suite, TypeScript, lint, local and Cloudflare production builds, eight local-auth desktop/mobile browser checks, and four cloud-mode calendar/contact checks with disposable storage. Browser coverage includes the Add paths, keyboard behavior, accessibility, mobile scroll position, and horizontal overflow; mobile screenshots were inspected.

This milestone does not complete onboarding or the broader daily-experience gate. Users still need a guided small-circle setup and a first real follow-up path, and the section terminology/data model remains mixed between tag Groups and Smart Lists. Live Google OAuth, deployed D1/R2, closed-app reminders, and remaining release gates are still unverified. No remote migration or deployment was performed.

### 2026-10-02: First Circle and First Real Step

- Added a first-run path on Today that starts with one person instead of a full contact import. People are added to the existing Close circle tag only when explicitly selected; the picker is searchable, limits the suggested circle to five, and preserves a failed selection for a safe retry.
- The guide links directly to the chosen person's birthday and check-in fields, then to a real logged conversation or a planned reminder. It does not treat opening a message app as completed outreach. Progress comes from stored circle membership and interaction history rather than a browser-only checklist, and the overview calculation is shared by local and cloud modes.
- The empty workspace now offers Add your first person as its primary action and contact import as an optional preview. No schema migration was needed.
- Verified the full local unit suite, TypeScript, lint, the Cloudflare production build, and desktop/mobile Chrome journeys for both onboarding and existing Today actions against disposable cloud storage. The new cloud test also confirms first-circle progress is isolated by workspace. Full-page desktop/mobile screenshots were inspected; no horizontal overflow or accessibility violations were reported by the browser journey.

This improves first-run guidance but does not close the daily-experience or release gates. Existing workspaces with logged history do not see this guide; a planned reminder alone does not mark the final step complete. The Close circle remains an ordinary editable tag, not a distinct group model. Live Google OAuth, deployed D1/R2, closed-app reminder delivery, and production-scale behavior remain unverified. No remote migration or deployment was performed.

### 2026-10-02: One Filterable Profile History

- Replaced the visible split between All activity and Conversations with one Activity area and shared filters for all events, conversations, reminders, context, and milestones. Filtered timeline pages are queried at the source in both local SQLite and tenant-scoped Cloudflare D1, with bounded pagination and explicit invalid-filter errors.
- Conversations remain editable in place. Opening one from the mixed timeline fetches its current revision before editing; an older item remains visible after a successful save instead of disappearing when the first page refreshes. In-flight older filtered pages are aborted when the person or filter changes.
- Kept the focused history directly below the filters on desktop and mobile. Fixed the desktop profile action menu stacking and darkened destructive controls so confirmation text meets automated contrast checks.
- Verified 256 local unit tests, TypeScript, lint, local and Cloudflare production builds, 43 passing workerd/D1 tests with one intentional large-count skip, six cloud-mode profile/onboarding browser journeys, and six local-auth accessibility journeys across desktop and mobile. The browser checks cover filtered pages, editing an older conversation, route and form accessibility, and horizontal overflow. No schema migration was required.

This closes the specific profile-history UX gap, not the broad release gates. The profile source file remains large, and the underlying interaction and mixed-timeline pagination APIs remain separate even though the UI presents one Activity surface. Live Google OAuth, deployed D1/R2 behavior, closed-app reminder delivery, production-scale quotas, and the other roadmap gates remain unverified. No remote migration or deployment was performed.

### 2026-10-02: Closed-App Reminder Email Foundation

- Added an opt-in, verified-account email channel for explicit due reminders, with account-scoped preferences, IANA timezones, quiet hours, a durable D1 event ledger, bounded Cron claims, retries, and generic message content that excludes contact details.
- Added a Reminders-page settings card with truthful availability and terminal-failure status. The channel is disabled by default until the sender domain and Email Sending binding are verified. Browser alerts remain separate.
- Added migration `0010_yellow_titanium_man.sql`, including tenant and lifecycle guards. Restore resets the delivery baseline; erasure deletes preferences and ledger records. SQLite and workerd tests cover opt-in, tenant scope, quiet hours, retries, deduplication, and deletion.

This is not live-delivery sign-off. Cloudflare Email Sending could not be inspected with the current OAuth token, no binding was configured, and no remote migration or deployment was performed. Birthday email, a scheduled digest, manual retry, uncertain-provider duplicate suppression, and authenticated production smoke tests remain open. See `docs/cloud-email-reminders.md` before activation.

### 2026-10-02: Account-Safe Browser Alerts

- Scoped browser alert preferences and reminder/birthday ledgers to the verified cloud account or local installation identity. Unscoped legacy preferences are deliberately not inherited by another account; users must opt in again.
- Revalidate identity before and after each notification fetch so an account switch cannot attribute another account's due events to the old ledger. Refresh identity on focus, visibility, and a bounded timer; unavailable identity now has a truthful UI state.
- Added a two-account browser regression using the same reminder ID and due time, plus a scoped-key unit test. This is separate from closed-app email delivery and does not make browser alerts run after the app closes.

### 2026-10-02: Bounded Reminder Email Digest

- Due reminders are claimed in one bounded D1 operation and combined into at most one generic email per workspace/account per Cron pass, up to 20 events per email and eight emails per pass. A fresh post-claim read checks active membership, verified address, reminder state, and current quiet hours before sending.
- Quiet-hour events move to the next allowed local quarter-hour instead of occupying the front of the queue. The calculation follows IANA daylight-saving transitions; a 100-event quiet backlog no longer blocks another recipient.
- Grouped failures preserve each event's own retry count and backoff. SQLite and workerd regressions cover batching, cross-workspace separation, quiet backlog, DST, retries, and overlapping scheduled claims. Sender activation still requires the verified Cloudflare binding and an authenticated live delivery drill.

This is an immediate due-reminder bundle, not a scheduled weekly digest or birthday email. Annual occasions need their own occurrence ledger and scheduling rules rather than being inserted as fake timed reminders. No remote migration or deployment was performed.

### 2026-10-02: Annual Birthday Email Alerts

- Added a separate tenant-scoped annual birthday email ledger and a bounded round-robin scan cursor. Alerts use the profile's lead-days setting, the account's IANA timezone and quiet hours, and the shared February 29 observation rule. The same verified-email opt-in controls both timed reminders and contact birthdays; messages remain generic and contain no names or notes.
- Recheck contact date, lead time, membership, account verification, and workspace lifecycle before sending. Edited birthdays invalidate stale pending events; each contact/occurrence can be delivered once per account. SQLite and workerd tests cover leap years, local-date boundaries, annual recurrence, retries, stale edits, bounded scanning, restore, and erasure.
- Cloud restore now turns email alerts off and clears both delivery ledgers, requiring explicit re-enablement rather than silently resending an occasion after source replacement. The restore confirmation and toast disclose this.
- Verification: 273/273 local tests, 58 passing workerd/D1 tests with two intentional large-count skips, TypeScript, lint, the Cloudflare production build, and four desktop/mobile browser checks pass. Browser checks use disposable local storage and mocked auth/sending, not the deployed service.

The Email Sending binding/domain are still unverified and the channel remains disabled in Wrangler. Contact-child birthdays, a scheduled weekly digest, live closed-app smoke tests, and large-workspace scan-cycle validation remain open. No remote migration or deployment was performed.

### 2026-10-02: Directory Navigation Context

- Search, exact tag, page, and grid/list view now live in the People URL. Opening a profile and returning restores the same result set and view; filter, page, and view changes support Back/Forward. A search session adds one history entry and replaces subsequent keystrokes instead of creating an entry per character.
- Preserve the existing log-moment intent and other URL parameters while changing directory state. Invalid page/view values fall back safely, and a stale page number is replaced with the server-clamped page. The saved view preference remains the fallback for fresh directory visits.
- Verified 275 local tests, TypeScript, lint, the Cloudflare production build, and four desktop/mobile browser journeys covering pagination, filtering, search Back/Forward, profile return, accessibility, and overflow. Browser journeys use disposable storage and mocked auth, not a deployed service. No migration or deployment was performed.

This closes the directory URL-state issue from the audit, not the broader release gate. Large-workspace recovery, live authenticated journeys, production quotas, and the other unchecked gates remain open.

### 2026-10-02: Scheduled Cloud Backup Foundation

- Added migration `0012_nebulous_bedlam.sql` for tenant-scoped backup schedules and timestamped backup-file states. A bounded Cron runner leases two due workspaces per pass, reuses the existing verified R2 snapshot, retries transient failures, reports oversized workspaces, and retains the newest automatic recovery point. Stale pins and partial R2 files are cleaned after one hour in resumable batches.
- Data & recovery now shows per-workspace due, current, failed, oversized, missing-file, or disabled protection states. Restore makes a new snapshot due; erasure removes the schedule. A green state requires both a successful schedule and a listed checksum-manifested automatic R2 object.
- Verified 281 local tests, 64 passing workerd/D1/R2 tests with two intentional unrelated large-count skips, TypeScript, lint, and desktop/mobile browser states with accessibility and overflow checks. The final Next.js compile passed; initial OpenNext packaging hit machine `ENOSPC`. Removing only the app's ignored `.next/cache` freed space, and `opennextjs-cloudflare build --skipNextBuild` completed packaging from that compiled output. No remote migration or deployment occurred.

The feature remains disabled by `CLOUD_AUTOMATIC_BACKUP_ENABLED=false`. Activation needs migration 0012, a controlled deployment, real Cron/R2 logs, and a live authenticated restore drill. Two attempts per 15 minutes and the 16 MB cap are not a broad-market daily-backup guarantee; larger workspaces need resumable recovery jobs and scale validation. See `docs/cloud-automatic-backups.md`.

### 2026-10-02: Legacy Stats Parity

- Replaced the cloud stats endpoint's hard-coded zero check-in count and empty action list with tenant-scoped, cadence-aware queries shared with the local endpoint. Both now expose a neutral `readyToReconnectCount`; the older `neglectedCount` remains calculated for compatibility but is not used by the current Today UI.
- Both endpoints accept an optional `timeZone`, count conversations only through the local today, observe February 29 birthdays on March 1 in non-leap years, and return an exact birthday count with a 100-person bounded list and `upcomingBirthdaysTruncated` flag.
- Verified 284 local tests, 65 passing workerd/D1/R2 tests with two intentional large-count skips, TypeScript, full lint, and diff checks. A fresh production bundle was not run because this machine had less than 1 GB free after the test suite. No remote migration or deployment occurred.

This closes the specific false-stats contract gap, not the broader cloud-parity or release gate. The legacy endpoint is not rendered by today's UI. Large-workspace recovery, live authenticated journeys, real Cloudflare quotas, and backup/email activation remain open.

### 2026-10-02: Check-In Day in Today

- Fixed a shared recommendation-model boundary: a person whose check-in preference is due exactly today now appears in Today, the reconnect smart list, and the due count. Previously all three waited until the following day even though the profile and stats endpoint said the check-in was due.
- Added `checkInsDueCount` to the overview and switched Today's visible “check-ins due” card to it. The older `overdueCount` and `overdue-*` snooze IDs remain for compatibility; snoozes still hide the due suggestion without changing history. Briefs and list reasons now use “Check-in day” or neutral “days past your check-in preference” wording instead of grading the relationship.
- Verified 286 local tests, 66 passing workerd/D1/R2 tests with two intentional large-count skips, TypeScript, and full lint. The new cloud regression covers the exact due day and tenant isolation. No browser build, remote migration, or deployment occurred.

Large-workspace recovery remains a separate trust blocker. The 16 MB guard cannot safely be raised without a resumable capture and restore design: current capture materializes all workspace rows in one request and restore replaces the graph in one D1 batch. Keep the guard until a staged, revision-checked, rollback-capable flow is implemented and exercised against real Cloudflare limits.

### 2026-10-02: Child Birthday Email Occasions

- Extended the existing opt-in, verified-account birthday email pipeline to cover children listed under a contact. Child occasions use their own bounded round-robin scan cursor and seven-day notice window; they share the same per-account generic email bundle, quiet hours, annual deduplication, retry policy, and delivery-status ledger as contact birthdays. No child or contact names enter the email.
- Added migration `0013_next_harry_osborn.sql` with a child-scoped event identity, cascading deletion, and tenant/parent guards. Restore clears both birthday scan cursors and delivery history and requires fresh email consent; erasure removes the new cursor. Tests cover leap-day observation, same-day parent and sibling occasions, cross-workspace rejection, overlap, stale edits, deletion, and restore.
- Verified 288 local tests, 68 passing workerd/D1/R2 tests with two intentional large-count skips, TypeScript, lint, migration checks, a Cloudflare production build, and the authenticated standalone local production smoke journey. The smoke test's old service-worker and CSV-header assertions were corrected to the current behavior. No remote migration or deployment occurred.

The channel remains disabled until Cloudflare Email Sending and the sender domain are verified, bound, and exercised with a real account. A child-list entry and a separate contact profile for the same person are still independent occasions and may count twice in one generic email; explicit linking is needed for a no-duplicates promise. The per-child notice window is currently fixed at seven days, not individually configurable. Large-population scan latency and actual provider delivery remain unverified. See `docs/cloud-email-reminders.md`.

### 2026-10-02: Linked Child Profiles and Birthday Deduplication

- Child entries can now optionally link to an existing contact in the same workspace. The parent profile shows the linked contact's current name and birthday and supports editing, unlinking, and profile navigation. Unlinked children still use their own name and birthday.
- A linked child's contact profile is the single birthday source for calendar and cloud email alerts. Linking cancels stale queued child email occasions; older backup versions remain restorable. Local schema version 6 and cloud migration `0014_modern_bloodstrike.sql` add the link, uniqueness, and tenant/self-link guards.
- Verification: 292 local tests, 70 passing workerd/D1/R2 tests with two intentional large-count skips, TypeScript, lint, a Cloudflare production build, and desktop/mobile Chrome journeys covering link, unlink, calendar deduplication, accessibility, and overflow. Browser journeys use disposable local storage and mocked cloud APIs, not the deployed service. The cloud sender remains disabled; no remote migration or deployment was performed.

This prevents duplicates only for explicitly linked children. It does not automatically infer family relationships or merge existing duplicates, and live email delivery and large-workspace recovery remain unverified.

### 2026-10-02: Recovery Publication and Download Integrity

- Finalized manual and scheduled cloud snapshots only when the workspace remains on the captured revision and the writing file and operation pin still exist. An edit during R2 upload now rejects publication and removes the failed object; scheduled status stays uncovered and retries.
- Direct managed-backup downloads reject non-ready files, oversized objects, and checksum mismatches. Added manual and scheduled concurrent-edit tests plus corrupted-download coverage. Verification: 294 local tests, 72 passing workerd/D1/R2 tests with two intentional large-count skips, TypeScript, lint, and a Cloudflare production build.
- Kept the 16 MB cap. Documented the bounded chunk/manifest and fenced, resumable restore protocol needed for large workspaces in `docs/cloud-large-recovery-design.md`; none of that protocol is yet implemented or deployed.

### 2026-10-02: Bounded Private Cloud Capture Foundation

- Added migrations `0015_boring_sharon_carter.sql` and `0016_brainy_rawhide_kid.sql` for tenant-scoped, revision-fenced capture jobs and chunk metadata. Internal capture walks CRM tables with bounded keyset pages, stores checksum-addressed R2 chunks, and survives retries without exposing a partial backup. Changed source data invalidates the job; erasure waits for an active capture lease and removes staged objects.
- Kept the completed capture in `awaiting_verification`, outside backup listings and restore. This is a staging foundation, not a recoverable large-workspace snapshot. The 16 MB interactive backup/restore limit is unchanged.
- Verified 304 local tests, 80 passing workerd/D1/R2 tests with four intentional large-count skips, TypeScript, lint, and a Cloudflare production build. The SQLite large-count test staged more than 16 MB in bounded chunks. No remote migration or deployment occurred.

Before this can protect user data, the app needs a re-read-verified manifest, graph validation, cleanup/retention, and a resumable restore with a verified pre-restore backup and rollback. Live Cloudflare quotas, interruption recovery, and authenticated production drills remain unverified; see `docs/cloud-large-recovery-design.md`.

### 2026-10-02: Private Large-Snapshot Manifest Verification

- Added migration `0017_nosy_sage.sql` for resumable verification progress, guarded private manifest publication, and immutable workspace ownership on captured CRM tables. Each verification step re-reads one R2 chunk, validates its bytes and rows against D1, and advances behind the workspace revision fence.
- Bounded manifest parts describe verified chunks; the root records counts, schema version, workspace identity, and a part hash chain. Publication checks source counts and references and remains internal as `manifest_ready`, not a backup in the product UI. A 17 MB SQLite test exercises multiple manifest parts without one large read.
- Verified 313 local tests, 89 passing workerd/D1/R2 tests with four intentional large-count skips, TypeScript, lint, and a Cloudflare production build. Corrupt and rehashed-but-changed chunks, source edits during publication, transient R2 failure, zero-chunk workspaces, and direct tenant moves are covered. No remote migration or deployment occurred.

The 16 MB interactive limit remains. This artifact still needs a bounded independent reader, retention and stale-job cleanup, and a resumable restore with pre-restore backup and rollback before it can be advertised as recoverable or used to permit destructive operations. Live Cloudflare quotas and authenticated restore drills are also unverified.

### 2026-10-02: Independent Private Snapshot Read Pass

- Added migration `0018_colorful_johnny_blaze.sql` for tenant-scoped, leased read jobs. The reader validates the root, one bounded manifest part, and one chunk per step from R2, then commits its cursor, per-table counts, and part hash chain in D1. It does not consult the capture job's D1 chunk index. Capture discard and erasure wait for active reads; completed read state can be removed without deleting the private snapshot.
- The shared artifact validator checks identity, schema, byte bounds, checksums, cursor order, and row shape. Tests cover corruption of the root, part, and chunk; a rehashed part that fails the root chain; transient R2 failure; tenant isolation; erasure races; and a 17 MB multi-part read after deleting D1 chunk metadata.
- Verified 320 local tests, 95 passing workerd/D1/R2 tests with five intentional large-count skips, TypeScript, lint, and a Cloudflare production build. No remote migration or deployment occurred.

The read job is validation-only and cannot restore data or protect destructive operations. Large-workspace release still needs retention and stale-job cleanup, a resumable destination write protocol, verified pre-restore rollback, final graph checks, live quota testing, and an authenticated restore drill. The 16 MB interactive limit remains.

### 2026-10-02: Bounded Snapshot Lifecycle Cleanup

- Added an internal scheduled cleanup pass for invalid capture jobs and idle validation cursors. Unfinished captures expire only after seven idle days with no live lease; invalid jobs are deleted in resumable R2 pages. Deletion outages retain the job for retry, and active capture/read leases remain protected.
- The 15-minute Cloudflare Cron now runs this pass beside export and small-backup maintenance. Published `manifest_ready` points are preserved rather than pruned by an arbitrary count before restore pinning and rollback are defined. No schema migration was needed for the cleanup itself.
- Verified 324 local tests, 98 passing workerd/D1/R2 tests with six intentional large-count skips, TypeScript, lint, and a Cloudflare production build. Tests cover idle thresholds, active leases, published-point preservation, interrupted deletion, and bounded 405-object cleanup. No remote migration or deployment occurred.

Large-workspace recovery remains internal and non-restorable. Published-point retention, a general orphan scan, rollback-safe resumable restore, final destination validation, live quotas, and authenticated production drills are still open; the 16 MB interactive guard stays in place.

### 2026-10-02: Private Restore Preparation

- Added migration 0019 and a durable, one-per-workspace preparation job. It independently reads the chosen published snapshot, captures a current-state rollback point in bounded steps, verifies its manifest, and marks preparation ready only when both reads are verified and the workspace revision still matches. No CRM data is replaced.
- Active preparations pin their capture/read dependencies against discard and Cron cleanup. Workspace edits invalidate ready or in-progress preparation; stale unfinished jobs release pins. Erasure refuses an active preparation lease and removes preparation rows before their referenced snapshots.
- Focused SQLite and workerd tests cover the full preparation, revision changes, R2 retry, tenant isolation, pin release, and erasure conflict. Apply migration 0019 only after migrations 0015-0018 and before deploying code that references the table. No remote migration or deployment occurred.

This is not a large-workspace restore. Destination write fencing, rechecking bytes during apply, final graph validation, rollback controls, protected published-point retention, live quota tests, and an authenticated restore drill remain open. The 16 MB interactive limit is unchanged.

### 2026-10-02: Maintenance Read and Delete Fence

- Cloud API dispatch now checks the authenticated workspace lifecycle before invoking a CRM handler. During erasure or future resumable restoration, normal reads and actions receive 423; the backup-status view remains available and erasure continuation remains possible. Settings disables conflicting recovery controls and explains the maintenance state.
- Migration 0020 adds database-level delete guards for every CRM snapshot table. Erasure's row deletion and transition to `erasing` remain one D1 transaction, so legitimate erasure still works while racing ordinary deletes are rejected. An inner lifecycle guard prevents an already-started erasure request from overtaking a restore.
- SQLite and workerd tests cover tenant isolation, route exceptions, blocked deletes, populated erasure, and recovery regression cases. Migration 0020 must follow 0019 before deploying this code. No remote migration or deployment occurred.

The private apply/rollback engine and maintenance fence are now exercised together in SQLite and workerd tests. A gated owner-only API and Settings UI now invoke them, but the flag is off and this is not a production-ready large-workspace recovery feature. Live Cloudflare quotas, durable background continuation, retention, and a production restore drill remain open.

## Private Large-Workspace Apply And Rollback

- Migrations 0021 and 0022 add bounded restore cursors and target/rollback source selection. The internal engine locks the workspace, deletes and writes in fenced D1 batches, rechecks R2 chunks, repairs trigger-modified contact dates, and verifies each destination row plus the final graph before unlocking. A failed target apply can restart from the independently verified pre-restore capture and end in `rolled_back`.
- Terminal restore records retain their referenced artifacts for 30 days, preventing foreign-key failures during cleanup. The current published-snapshot policy is still intentionally conservative, not a finished storage-retention product.
- The new Advanced recovery page captures private snapshots, prepares a verified rollback point, and offers explicit apply, pause/resume, rollback, and removal controls. Route tests cover owner/tenant boundaries and locked-workspace continuation; desktop/mobile browser tests cover typed confirmation and accessibility with mocked cloud responses. `CLOUD_LARGE_RECOVERY_ENABLED=false` remains the default.
- No remote migrations or deployment occurred. Keep the 16 MB interactive guard and disabled flag until published-snapshot retention, reliable long-job continuation, large live-service quota tests, and an authenticated end-to-end recovery drill are complete.

### 2026-10-02: Queued Restore Continuation

- Migration 0023 adds persisted background state and a progress version. Applying or rolling back a prepared large snapshot now publishes a Cloudflare Queue message; the consumer advances one lease-protected step, versions progress, and enqueues the next. A 15-minute Cron scan republishes stale running work after a lost message. Stale/duplicate messages cannot restart a paused or rolled-back target operation.
- The owner can pause and resume on the server. The Advanced recovery page polls status instead of driving apply/rollback steps, so closing the tab no longer stops a healthy queued restore. Queue publication failures and exhausted step retries leave a visible, resumable failed state rather than a silent spinner.
- The feature flag remains off. Queues and migration 0023 are not provisioned remotely, and no deployment was performed. Live Queue delivery, actual D1/R2 quotas, published-point retention, and a production restore drill remain release gates; this local implementation does not prove them.
- Verified 356 local tests, seven focused workerd/D1/R2 Queue tests, TypeScript, and lint. A fresh production build and browser E2E run were deferred because this machine had less than 500 MB free; the last browser bundle would not include these changes.

### 2026-10-03: People Directory Payload And Recovery Routing

- Fixed the cloud rewrite allowlist for Advanced recovery Pause and Resume. Without this, the new server actions would return 501 in Google-auth mode despite passing handler-level tests. A route-contract test now covers both actions.
- Local SQLite and cloud D1 directory pages now return only the fields needed for person cards. Search still examines private notes and custom context server-side, but list responses omit them. Manual company/location context takes precedence over imported LinkedIn details in the subtitle.
- Embedded photos load lazily from an authenticated, tenant-scoped, no-store endpoint instead of repeating up to 135 KB of image data per contact in directory JSON. The avatar helper accepts only that same-origin endpoint or a validated embedded photo; arbitrary remote photo URLs remain blocked.
- Verified 358 local tests, 13 focused workerd/D1/R2 product tests, TypeScript, and lint. A fresh production build and browser E2E were not run because the host still has about 540 MB free. No migration or deployment occurred in this milestone; the broader release gates above remain open.

### 2026-10-03: Complete Cloud Tag Groups

- Removed the cloud tag-group reader's silent 10,000-contact limit. Summaries and member/available pickers now count and page tenant-scoped rows in SQL instead of loading an entire workspace into Worker memory. Invalid legacy tag JSON remains safe to read.
- A 10,001-contact SQLite regression verifies that a group belonging only to the last contact is visible. A separate Worker/D1 test covers case-insensitive membership, pagination, malformed legacy tags, and workspace isolation.
- Verified 360 local tests, the focused Worker test, TypeScript, and lint. Disk remained around 528 MB free, so no fresh production build or browser E2E ran. Cache cleanup is pending user authorization; no cache, CRM data, remote migration, or deployment was changed.

### 2026-10-03: Cloud Action Parity Audit

- Cloud mode now routes the deterministic email-domain enrichment action used by Add contact. The handler uses the same local enrichment rules, returns the same response shape, and does not call an external data provider. Focused tests pass in both SQLite and workerd.
- The People menu and direct duplicate-review page no longer present a broken cloud merge. The local merge remains available. This is an interim capability boundary, not completion: cloud duplicate cleanup still needs tenant-scoped duplicate detection, a verified pre-merge recovery point, atomic reassignment of every dependent record, collision handling for relationships and linked children, and authenticated end-to-end verification.
- A route-map contract now enumerates cloud-visible People, Today, Calendar, and Settings actions, including Advanced recovery Pause/Resume, to catch missing rewrites earlier. It explicitly records duplicate merge as unsupported until implemented.
- The full local suite passes after the enrichment and UI changes; TypeScript and lint pass. The host still lacks room for a fresh production build and browser run. No remote migration or deployment occurred.

### 2026-10-03: Internal Cloud Duplicate-Merge Foundation

- Extracted the local merge's field and connection planner so cloud and SQLite use the same verified-duplicate selection and graph-collision rules. The local path now also preserves incoming linked-child references when a duplicate profile is removed.
- Added an internal tenant-scoped D1 merge transaction that first creates and verifies a pre-merge R2 recovery point. It moves activities, group memberships, import references, relationships, linked children, and snoozes, including embedded birthday/check-in prompt IDs. A revision guard aborts if workspace data changes after the recovery point is captured.
- Existing birthday-email delivery rows on a duplicate or a child link that would be collapsed block the merge rather than being silently deleted by a cascade. This is a safety boundary pending an explicit delivery-ledger reconciliation design.
- Four focused merge cases pass in both SQLite and disposable Workerd D1/R2, covering data preservation, tenant isolation, storage failure, concurrent edits, self-child conflict, and delivery-history protection. The full 370-test local suite, TypeScript, and lint pass.
- The new handler is **not** connected to the public cloud route or UI. Cloud duplicate review still needs scalable tenant-scoped detection, an accurate review/confirmation flow, additional collision and rollback tests, authenticated browser verification, and a production build. Interactive recovery still has a 16 MB limit; no remote migration or deployment occurred.

### 2026-10-03: Cloud Duplicate Review And Merge UI

- Connected the authenticated cloud duplicate route and reopened Clean up duplicates in the People menu. Cloud review scans identity-only D1 pages of 500 by contact ID, checks one workspace recovery revision across pages, and builds the same transitive email, phone, and name/birthday groups as local mode. No arbitrary 10,000-contact cutoff or full-directory Worker response is used; private notes and embedded photo bytes are excluded from scan pages.
- The page shows scan progress and only offers completed groups. A merge posts the scanned revision, so an edit after review produces a refresh-required conflict before writing a recovery point; the existing post-backup revision guard still protects concurrent edits. A successful merge followed by a failed review refresh is reported as a successful merge with a separate refresh error.
- Shared duplicate pagination and safe-batch selection now serve local and cloud UI. Tests cover grouping across scan pages, tenant isolation, data redaction, invalid/stale cursors, a match beyond contact 10,000, stale confirmation, and the existing merge safety cases. Verification: 375/375 local tests, focused disposable Workerd D1/R2 tests, lint, TypeScript, and diff checks pass.
- This has not been deployed. The cloud page still accumulates identity projections in the browser, so very large workspace memory and scan duration need measured limits or a durable scan job. Merges still require an interactive recovery snapshot under 16 MB, and birthday-email history currently blocks affected merges rather than risking cascade loss. No fresh production build or authenticated browser journey ran because the host has under 400 MB free. Live OAuth, D1/R2 quotas, an uncertain-response retry drill, and production recovery remain open.

### 2026-10-03: Confirmable Cloud Merge Retries

- Cloud merges now require a UUID idempotency key. A receipt containing the request fingerprint, primary profile, and recovery filename commits in the same D1 transaction as the merge. Retrying the same request confirms the committed result without creating a second recovery point; reusing the key for different inputs fails. Restoring an older snapshot invalidates the receipt rather than replaying stale success.
- The duplicate page holds the exact request key and body after an uncertain network or JSON response, distinguishes a confirmed replay from a new merge, and directs the user to retry safely. Birthday-email delivery history still blocks affected merges: reassigning annual occurrence records or collapsing child-linked events without a dedicated provenance and deduplication design could hide a needed alert or erase audit history.
- Focused SQLite and Workerd tests cover replay, key reuse conflicts, and restore invalidation. The full 378-test local suite, TypeScript, lint, and diff checks pass. No deployment, production build, or authenticated browser journey occurred; the machine remains below 400 MB free, and the broader release gates remain open.

### 2026-10-03: Mergeable Large Duplicate Groups

- Changed the shared 21-profile batch selector to walk verified identity signals outward from the recommended primary. Previously a large transitive group could offer the far-end primary with the first 20 IDs, forming a disconnected subset that both local and cloud merge correctly rejected. The selected subset is now connected and retains the primary.
- SQLite and disposable Workerd tests merge a 25-profile identity chain in two review-and-merge passes, with the primary and its history preserved. This checks that the remainder stays connected after the first merge, not just that the first batch validates.
- Split the duplicate choice card's Inspect profile link out of its radio label. The accessibility contract now detects links or buttons nested inside labels throughout the app. Verification: 380/380 local tests, the focused Workerd journey, TypeScript, lint, and diff checks pass.
- No remote deployment, production build, or authenticated browser journey occurred. Browser scan scale, the 16 MB interactive recovery cap, birthday-email ledger reconciliation, and the broader roadmap gates remain open.

### 2026-10-03: Cloud Duplicate Browser Verification

- A fresh Google-auth Cloudflare production build completed successfully and included the duplicate-review page. The duplicate page's introductory and recovery-point copy is shorter, keeping the merge choices closer to the top on mobile.
- A cloud-mode Chrome browser journey passed on desktop and mobile against disposable D1/R2-backed handlers. It logs in through the test server, scans a matching group, checks the accessible choice and profile link, verifies WCAG 2 A/AA and 2.1 A/AA rules and horizontal overflow, then loses the first merge response after commit. Retrying sends the same idempotency key, confirms the existing merge, and leaves one recovery point with the duplicate's notes preserved.
- Verification: 380/380 local tests, TypeScript, lint, Cloudflare production build, two cloud-mode browser runs, and visual review of desktop/mobile screenshots. The browser's Google session endpoint was mocked; this does not establish live Google OAuth, deployed D1/R2 behavior, or a production recovery drill. No remote migration or deployment occurred. Browser scan scale, the 16 MB interactive recovery cap, birthday-email ledger reconciliation, and the broader release gates remain open.

### 2026-10-03: Lean Cloud Duplicate Review

- Split cloud review into a 500-contact identity scan and a revision-checked detail fetch for only the current page's safe merge batches. The scan no longer transfers photos, tags, last-contacted context, or per-category history counts for every person; it carries matching signals and the same aggregate ranking score. A page of ten groups hydrates at most 210 contacts, preserving the existing primary recommendation and connected-batch rules.
- Detail requests reject invalid, duplicate, oversized, missing, foreign-workspace, and stale selections. Browser pagination confirms that 11 groups fetch 20 visible contact details on page one and only two on page two. The lost-response merge retry journey still passes on both desktop and mobile.
- Verification: 380/380 local tests, focused disposable Workerd/D1 tests, four cloud-mode Chrome runs, a fresh Cloudflare production build, TypeScript, lint, and diff checks pass. This reduces scan payload and browser-held private context but still scans and groups all identity projections in the browser; it is not a durable large-workspace scan or a live quota result. No migration or deployment occurred. The 16 MB interactive recovery cap, birthday-email ledger reconciliation, live Google OAuth, and production recovery drill remain open.

### 2026-10-03: Security Update Verified, Audit Gate Open

- With approval, removed only generated Next/OpenNext output and npm's download cache. An interrupted install had left Next.js declaration files missing; a clean `npm ci` from the patched lockfile repaired the dependency tree. The resolved versions are Next.js and ESLint config 15.5.27, OpenNext 1.20.7, PostCSS 8.5.28, Wrangler 4.147.0, and its paired Miniflare 5 runtime.
- Miniflare 5 rejects the harness's old constructor shape. The disposable Workerd test harness now uses its V4-options converter; a focused cloud test and the complete runtime suite pass. Verification on the clean install: 381 local tests, 142 Workerd/D1/R2 tests with 11 intentional large-count skips, TypeScript, lint, a fresh Google-auth Cloudflare production build, and four desktop/mobile Chrome duplicate-review journeys. The build still emits the existing `jose` Edge Runtime compression warnings and a stale Browserslist-data notice.
- `npm audit --omit=dev --audit-level=moderate` reports five moderate findings, all through Drizzle Kit's old esbuild development loader via Better Auth; no production-graph high or critical findings remain. The full `npm audit --audit-level=moderate` still reports 18 findings (one low, seven moderate, ten high) in development/build dependencies, so CI's audit gate remains red. A non-breaking audit-fix dry run was stopped before changing files when its metadata fetch consumed the remaining disk; its cache was cleared again. Do not force a breaking Drizzle Kit or Tailwind downgrade/upgrade merely to silence the report.
- No remote migration or deployment occurred. Live Google OAuth, actual D1/R2/Queue quotas, restore drills, and the other release gates above remain unverified. This is a locally verified dependency update, not a release sign-off.

### 2026-10-03: Non-Forced Dependency Advisory Reduction

- Applied `npm audit fix --package-lock-only` without `--force`, then reinstalled from the resulting lockfile. The manifest and framework versions did not change. Patched transitive versions include `@humanfs/node` 0.16.8, `baseline-browser-mapping` 2.11.27, `browserslist` 4.29.3, `brace-expansion` 1.1.21, `js-yaml` 4.3.2, and `postcss-selector-parser` 6.1.4.
- Verified the new installed tree with 381 local tests, 142 passing Workerd/D1/R2 tests and 11 intentional large-count skips, TypeScript, lint, a fresh Google-auth Cloudflare build, and four desktop/mobile Chrome duplicate-review runs. The build still reports the `jose` Edge compression warnings and a bundled Better Auth duplicate-key warning; it completes and excludes database and environment files from standalone output.
- The full installed-tree audit fell from 18 to 11 findings: seven high findings share the unpatched `braces` dependency through Tailwind 3 and Next ESLint's glob tooling; four moderate findings share Drizzle Kit's old esbuild loader. The production-graph audit reports only the four esbuild-loader moderates and no high or critical findings. npm's offered fixes for both remaining paths are breaking changes. CI's full moderate audit remains red; neither an untested major migration nor a silent audit bypass was applied.
- No remote migration or deployment occurred. The remaining dependency triage and all other release gates above remain open.
