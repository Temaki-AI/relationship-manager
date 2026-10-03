# Everclose: Code, Experience, and Product Audit

Reviewed 4 September 2026 against the current working tree. This is a new audit checkpoint, not deployment approval. Earlier audit reports contain historical findings that have since been fixed.

## Findings

### 1. P1: The current cloud import screen cannot use the new backend

The contact screen posts a file without an Idempotency-Key and expects immediate imported/skipped counters. The dispatcher now calls createCloudImport, which requires that header and returns a staged job, not an import result. Reproducing the screen's request against the cloud handler returned HTTP 400: "An Idempotency-Key header is required for this create request." Adding a key returned a preparing job with one pending row and zero contacts. There is no import-report page to prepare, review, confirm, and resume this job.

Evidence: [upload UI](/Users/fernandoamaral/Dev/Personal%20CRM/app/contacts/page.tsx:237), [dispatch](/Users/fernandoamaral/Dev/Personal%20CRM/app/api/cloud/%5B...path%5D/route.ts:20), [new handler](/Users/fernandoamaral/Dev/Personal%20CRM/lib/cloud/import-api.ts:62).

Finish the entire job journey before releasing the switch. Keep one retry key for an uncertain upload; show preview and explicit duplicate decisions; reconcile every row; preserve reports and provide resume/cancel/remove controls. Remove the unused legacy import implementation after integration. A header-only fix would still produce a misleading "0 imported" response in the current UI.

### 2. P1: The checkout fails release checks despite passing existing tests

TypeScript fails at the vCard and CSV preview branches: last_contacted is inferred as string | number | null, while ImportContact requires string | null. Lint fails because handleCloudImport remains imported but unused. Existing tests do not cover the new import UI/API contract, so all 220 tests pass while this user journey is broken.

Evidence: [preview types](/Users/fernandoamaral/Dev/Personal%20CRM/lib/import-preview.ts:22), [second branch](/Users/fernandoamaral/Dev/Personal%20CRM/lib/import-preview.ts:30), [unused import](/Users/fernandoamaral/Dev/Personal%20CRM/app/api/cloud/%5B...path%5D/route.ts:3), [CI](/Users/fernandoamaral/Dev/Personal%20CRM/.github/workflows/ci.yml).

Fix the type contract, then add browser-to-cloud import tests, including malformed rows, lost responses, concurrent advances, restoration during import, and source-file retention. Require TypeScript, lint, both production builds, migrations, and authenticated journeys before deployment.

### 3. P1: Cloud contact exports silently stop at 10,000 people

Both CSV and vCard exports select at most 10,000 contacts and return a normal downloadable file without a truncation warning. A larger workspace receives an incomplete export that looks complete. CSV also omits photos and custom fields; these formats are not interchangeable with a full relationship-history backup.

Evidence: [cloud export](/Users/fernandoamaral/Dev/Personal%20CRM/lib/cloud/portable-api.ts:32), [CSV columns](/Users/fernandoamaral/Dev/Personal%20CRM/lib/contact-export.ts:4).

Provide a consistent, complete streaming or background export with final counts. If an operation is too large, fail explicitly instead of silently dropping records. Explain contact export versus full workspace backup and test round trips for the advertised fields.

### 4. P2: Alerts still require an open application

Birthday candidate calculation is now implemented, but delivery is a page effect that polls and constructs window.Notification. It is not a server scheduler or closed-app push-delivery system. A user enabling a birthday alert can still miss it if Everclose is closed. Fetch failures are silently ignored by the poller.

Evidence: [notification effect](/Users/fernandoamaral/Dev/Personal%20CRM/components/reminder-notification-provider.tsx:108), [service worker](/Users/fernandoamaral/Dev/Personal%20CRM/public/sw.js).

Keep the current limitation explicit. Add server scheduling, durable delivery attempts, timezone preferences, quiet hours, snooze, and a configurable digest. Browser push requires a different delivery path from a page-only notification; see the [Push API documentation](https://developer.mozilla.org/en-US/docs/Web/API/Push_API). Verify delivery with the application closed, not just candidate generation.

### 5. P2: Cloud mode still exposes unsupported actions and contradictory privacy copy

The new-contact Auto-fill action calls /api/enrich, and People links to duplicate cleanup. These APIs are absent from the cloud rewrite allowlist and fall through to an explicit 501. Capabilities are a static shared list rather than a backend-aware contract. First-run copy says contact files are processed locally, although cloud imports upload them to the server; the new engine also retains the original source file until report removal or workspace erasure.

Evidence: [Auto-fill](/Users/fernandoamaral/Dev/Personal%20CRM/app/contacts/new/page.tsx:45), [cleanup link](/Users/fernandoamaral/Dev/Personal%20CRM/app/contacts/page.tsx:451), [routing](/Users/fernandoamaral/Dev/Personal%20CRM/middleware.ts:107), [fallback](/Users/fernandoamaral/Dev/Personal%20CRM/middleware.ts:248), [onboarding](/Users/fernandoamaral/Dev/Personal%20CRM/app/page.tsx:120), [source retention](/Users/fernandoamaral/Dev/Personal%20CRM/lib/cloud/import-api.ts:56).

Return explicit capabilities from the active backend. Hide or explain unavailable controls, and show upload/storage/retention information before importing. Test every visible action in hosted mode.

### 6. P2: Relationship grades misrepresent the data

Unknown last-contacted dates receive 100% health. With a 14-day cadence, eight days produces about 43%, labeled Neglected, even though the requested check-in is not due. This confuses logging completeness with relationship quality. The newer neutral brief does not remove the older directory/profile grades.

Evidence: [calculation and labels](/Users/fernandoamaral/Dev/Personal%20CRM/lib/utils.ts:22).

Replace percentages with Not tracking yet, On track, Due soon, and Ready to reconnect. Show concrete timing and let users pause tracking. Do not score affection or closeness from database activity.

### 7. P2: The people list can show stale imported context after an edit

getContactSubtitle reads custom_fields.linkedin.company/location and otherwise falls back to email/phone. It ignores the editable top-level company/location values. A user correcting an old employer can still see the old imported employer in People, even though the newer intelligence calculations prefer manual context.

Evidence: [subtitle selection](/Users/fernandoamaral/Dev/Personal%20CRM/app/contacts/page.tsx:69).

Use one provenance-aware display selector across directory, profile, search, and briefs. Manual corrections should win; show source and last-confirmed date when helpful.

### 8. P2: Recovery is safer, but still has operational limits

Verified snapshots, restoration, retention, and resumable erasure are implemented and covered by passing cloud tests. However, interactive recovery stops at 16 MB, scheduled cloud backups are disabled, and abandoned backup pins lack a user-facing recovery workflow. An interrupted operation can leave protected files behind; erasure refuses to proceed while pins exist. The size limit fails safely, but larger workspaces have no alternate recovery path.

Evidence: [size limit](/Users/fernandoamaral/Dev/Personal%20CRM/lib/cloud/recovery-contract.ts:11), [disabled scheduling](/Users/fernandoamaral/Dev/Personal%20CRM/lib/cloud/recovery-storage.ts:90), [pins](/Users/fernandoamaral/Dev/Personal%20CRM/lib/cloud/recovery-storage.ts:106), [erasure guard](/Users/fernandoamaral/Dev/Personal%20CRM/lib/cloud/backup-api.ts:111).

Add bounded background recovery, fenced cancellation of interrupted operations, orphan cleanup, and scheduled checkpoints. Complete authenticated restore/erase drills before broad launch.

### 9. P2: Dependency and scale assurance need explicit work

A fresh npm audit --omit=dev reports 14 affected packages: eight high and six moderate, zero critical. This includes tooling pulled into the dependency graph; it is not evidence of 14 exploitable production vulnerabilities. Do not force-upgrade indiscriminately. Triage runtime reachability, use compatible patches, and validate OpenNext builds.

Directory queries still return complete contact rows, including embedded photos and long notes. Overview generation reads all contact signals and ranks workspace interaction history. These are plausible growth bottlenecks, not measured production incidents. The new import engine limits batch counts but still needs representative large-file CPU, memory, query, and concurrency tests. Cloudflare documents 50 queries per Free invocation, 1,000 on Paid, and a 2 MB row/string/BLOB limit; confirm the actual deployed plan and budgets against the [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

Evidence: [list projection](/Users/fernandoamaral/Dev/Personal%20CRM/lib/cloud/contact-api.ts:157), [overview reads](/Users/fernandoamaral/Dev/Personal%20CRM/lib/cloud/intelligence-directory.ts:9), [import bounds](/Users/fernandoamaral/Dev/Personal%20CRM/lib/cloud/import-api.ts:117).

## UI and Experience

The warm background, rose accent, readable typography, and consistent rounded surfaces are worth keeping. No horizontal overflow was observed at the reviewed desktop and mobile sizes. The main problem is prioritization, not a need for a wholesale visual rebrand.

| Area | Observed friction | Recommended change |
| --- | --- | --- |
| Today | Setup/data-ownership panels and counters compete with the daily queue; cards only navigate elsewhere. | Lead with three to five people, why now, one useful memory, and Reach out / Log / Snooze. Put explicit commitments and occasions before generic cadence. |
| People | At 390 px wide, bulk controls appear before search and the first person begins around 660 px down. | Search first; compact list on phones; filters in a sheet; bulk controls only after selection; transfer/cleanup in a secondary menu. |
| Profile | The demo profile's Log button is around 3,640 px below the top on mobile; delete is near the top. | Sticky Message / Log / Remind actions; edit/delete in overflow; Overview / Timeline / Details sections; one history instead of competing timeline/log panels. |
| Calendar | Mobile starts in month view; introduction and filters push the grid near the bottom of the first viewport. Event details only link to the person. | Agenda-first on phones, compact navigation, collapsible filters, Add reminder/plan, and Complete / Snooze / Edit event actions. |
| New person | Roughly twenty inputs precede the bottom Save action. | Save with name and optional contact method/note; progressively reveal other details; keep Save visible and protect drafts with a clear privacy lifecycle. |
| Navigation | At 1280 px, the brand, Smart Lists, and Add Contact labels wrap. Several top-level destinations overlap. | Today / People / Calendar / Settings, plus Add. Put Circles and saved lists inside People. Preserve search/filter/view state in the URL. |

Opening a messaging app must not automatically count as a completed conversation. Offer a small post-action prompt to log what actually happened. Avoid replacing useful empty states with fabricated urgency; allow reminders and tracking to be paused without guilt.

## Product Direction

Position the product as a personal relationship companion: **Remember what matters. Follow through with the people you care about.** Use Everclose as the visible name; CRM can remain a domain/category descriptor.

The central loop should be: notice a meaningful moment, take an action, capture one detail, choose a next step. Success is less administration and better follow-through, not more fields or imported contacts. Start onboarding with five to ten chosen people rather than the whole address book. Treat that number as a design hypothesis to test, not an established optimum.

Prioritize commitments such as "ask about the interview next week" alongside birthdays and optional cadence. Let users confirm or retire stale facts, archive relationships, and suppress sensitive occasions. One child should be linkable to both parents without creating divergent birthday records. The current child table attaches each child row to one contact, while contact-to-contact relationships already allow flexible labels. Evolve toward a shared person/family-context model rather than imposing a nuclear-family structure. Evidence: [child schema](/Users/fernandoamaral/Dev/Personal%20CRM/lib/cloud/schema.ts:120).

Reduce maintenance with consented one-way contact/calendar updates and provenance before adding extensive AI features. Start with source-linked deterministic briefs. Optional later search or drafting should distinguish facts, stale information, and inference; require review; never autonomously message contacts. A decorative relationship graph is lower priority than quick capture and reliable reminders.

Finish shared identity and actual synchronization before presenting iOS as a cloud companion. The mobile implementation writes local SQLite data and enqueues sync intents; that queue alone does not synchronize with the hosted account. Evidence: [mobile queue](/Users/fernandoamaral/Dev/Personal%20CRM/apps/mobile/src/data/sync-queue.ts:7).

## Recommended Sequence

1. **Make the current release trustworthy:** finish imports end to end; fix compilation/lint; complete exports; capability-aware privacy copy; recovery interruption handling; dependency triage; cloud builds and authenticated journeys.
2. **Make the daily loop effortless:** Today actions, compact mobile People, profile quick logging, progressive capture, and actionable agenda calendar. Keep the existing visual identity.
3. **Make reminders dependable:** durable scheduling, closed-app delivery, snooze/quiet hours, delivery status, and a configurable digest.
4. **Reduce data maintenance:** selected contact/calendar integration, provenance, shared family records, authenticated iOS sync; then optional source-grounded assistance.

Suggested acceptance measures: time to first useful follow-up, time to log a conversation, reminder delivery/retry success, unresolved import rows, successful restore drills, and four/eight-week retention. These are proposed measures, not current measured business outcomes. Avoid optimizing streaks or contact-count growth at the expense of genuine usefulness.

## Verification and Boundaries

- Existing full suite: 220/220 pass. Existing Cloudflare runtime suite: 23/23 pass using disposable D1/R2 after allowing local test sockets.
- TypeScript fails with two errors in import-preview.ts. Lint fails on one unused import warning under the zero-warning policy.
- Reproduced the import header/response mismatch with disposable data against actual cloud handler source using the SQLite-backed harness. The new job engine has no dedicated regression suite yet.
- A separate new-import Cloudflare-runtime probe stalled before producing a result and was stopped; it is not counted as a pass or a diagnosed import-engine defect. The 23 existing cloud tests above completed successfully.
- Inspected five local demo screens at 1280 x 900 and 390 x 844: Today, People, profile, calendar, and new person. Screenshots are in /tmp/everclose-audit-*.png. Chrome was launched in a fresh headless session; private browser sessions and production contact data were not inspected.
- Automated mobile accessibility scans reported no violations on People, profile, calendar, or new person. A dashboard contrast warning during its entrance animation did not reproduce after settling with reduced motion. These checks do not replace keyboard, screen-reader, zoom, or real-device testing.
- Dependency advisories were refreshed from npm. No dependencies or application behavior were changed for this audit.
- Production/cloud builds, live OAuth, real iPhone Safari, full end-to-end tests, production performance, remote migrations, and deployment were not performed. This review does not establish that the live domain matches the checkout or that the earlier Chrome dangerous-site warning is resolved.

**Overall judgment:** a promising private beta with a substantially stronger safety foundation, but the current checkout is not a release candidate. Finishing existing promises and simplifying the daily experience will create more value than adding another feature category.
