# Everclose: Current-State Engineering and Product Audit

Reviewed 4 September 2026. This report revalidates the current working tree after the recovery/write-safety work. It supersedes the current-status claims in the earlier audit, not its historical evidence. No application behavior was changed or deployed during this review.

## Findings

### 1. P1: Cloud recommendations and profile history are still placeholders

The cloud overview returns zero overdue contacts and an empty feed, smart lists return an empty array, and profiles return a generic brief and empty timeline. This makes unavailable calculations appear to be an all-clear result.

Reproduced with a disposable contact whose last interaction was January 1 and cadence seven days: overview reported one contact but zero overdue and no suggestions. Profile history contained the interaction, but timeline remained empty.

Evidence: [overview](/Users/fernandoamaral/Dev/Personal%20CRM/lib/cloud/core-api.ts:225), [smart lists](/Users/fernandoamaral/Dev/Personal%20CRM/lib/cloud/core-api.ts:323), [profile](/Users/fernandoamaral/Dev/Personal%20CRM/lib/cloud/contact-api.ts:274).

Recommendation: finish shared domain calculations and wire them into the cloud routes. The new cloud intelligence module is not yet connected to the dispatcher. Test outputs against both storage backends, including two-workspace isolation. Never show a fabricated zero for an unimplemented calculation.

### 2. P1: Cloud birthdays do not notify, and calendar dates ignore timezone

The cloud notification endpoint still returns `birthdays: []`. A September 4 birthday produced no candidate on September 4. A reminder at `2026-09-04T23:30:00Z` appeared on September 4 despite requesting Europe/Lisbon, where its date is September 5. Cloud February 29 birthdays also have no non-leap-year occurrence policy in the calendar query.

Evidence: [notifications](/Users/fernandoamaral/Dev/Personal%20CRM/lib/cloud/core-api.ts:71), [calendar](/Users/fernandoamaral/Dev/Personal%20CRM/lib/cloud/core-api.ts:242), [browser polling](/Users/fernandoamaral/Dev/Personal%20CRM/components/reminder-notification-provider.tsx:114).

Recommendation: one birthday/date policy across Today, calendar, notifications, and statistics. Separate date-only occasions from timed reminders. Add durable scheduled delivery, delivery records, snooze, quiet hours, and user-selected channels. Current web notifications depend on an open application; they are not reliable closed-app delivery.

### 3. P1: Cloud import can partially fail or silently discard contacts

Import runs a duplicate lookup and insert per contact, sequentially, for up to 5,000 contacts in one request. That can require roughly 10,000 queries. Cloudflare currently documents 1,000 queries per invocation on Paid and 50 on Free. Infrastructure errors are counted as invalid contacts. CSV normalization drops invalid rows without reporting them; identical name with absent birthday is treated as a duplicate; CSV import omits several exported fields. Exports also silently stop at 10,000 contacts.

Evidence: [import loop](/Users/fernandoamaral/Dev/Personal%20CRM/lib/cloud/portable-api.ts:72), [silent CSV skip](/Users/fernandoamaral/Dev/Personal%20CRM/lib/cloud/portable-api.ts:140), [field mapping](/Users/fernandoamaral/Dev/Personal%20CRM/lib/cloud/portable-api.ts:57), [export cap](/Users/fernandoamaral/Dev/Personal%20CRM/lib/cloud/portable-api.ts:32), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

Recommendation: preview, explicit duplicate review, bounded resumable jobs, stable row IDs, and a persistent reconciliation report. Every input row needs an outcome. Keep infrastructure failure separate from malformed data; verify export/import round trips and complete exports.

### 4. P2: Concurrent bulk tags lose updates; larger selections exceed bind limits

Bulk tagging reads tags and then writes a replacement without checking whether they changed. Reproduced two concurrent additions: both returned 200, but the final contact retained only `work`, losing `friends`. The endpoint accepts 500 IDs while the selection query binds each ID plus the workspace; D1 allows 100 parameters per query.

Evidence: [read/replace mutation](/Users/fernandoamaral/Dev/Personal%20CRM/lib/cloud/contact-api.ts:162), [accepted selection](/Users/fernandoamaral/Dev/Personal%20CRM/lib/cloud/contact-api.ts:191), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

Recommendation: atomic tag changes or revision-checked retries, plus JSON-bound selections or bounded chunks. Apply conflict protection to other editable resources, not just contacts/interactions.

### 5. P2: Search and tag filters are misleading in cloud mode

Requesting `tag=friends` returned a work-only contact. Searching for Lisbon returned nothing even though Lisbon was in that contact's notes. The interface explicitly promises notes and imported-context search.

Evidence: [cloud list](/Users/fernandoamaral/Dev/Personal%20CRM/lib/cloud/contact-api.ts:103), [search promise](/Users/fernandoamaral/Dev/Personal%20CRM/app/contacts/page.tsx:665).

Recommendation: shared, tested filter semantics for tags, notes, company, location, and imported context; preserve search/filter/view state in the URL. Use lightweight list projections instead of returning full embedded photos and all notes.

### 6. P2: Deduplicating Today suggestions currently hides birthday context

The in-progress feed code keeps one primary item per person, putting other details into `reasons`. The dashboard renders only `title` and `detail`, not those reasons. When a high-priority cadence item wins, an upcoming birthday disappears from the visible card. The birthday feed regression test reproduces this: only one of three expected birthday items remains.

Evidence: [deduplication](/Users/fernandoamaral/Dev/Personal%20CRM/lib/intelligence.ts:544), [rendering](/Users/fernandoamaral/Dev/Personal%20CRM/app/page.tsx:333).

Recommendation: aggregate structured reasons and source actions per person, prioritizing explicit reminders and occasions while retaining their titles/dates. Render the combined context. Do not merely loosen the test to hide the lost information.

### 7. P2: Relationship health grades are mathematically and emotionally misleading

No recorded last-contacted date becomes 100% health. With a 14-day cadence, eight elapsed days produces roughly 43% and the label Neglected, before the requested interval has passed. Recent neutral brief wording does not fix these remaining directory/profile grades.

Evidence: [health calculation and labels](/Users/fernandoamaral/Dev/Personal%20CRM/lib/utils.ts:22).

Recommendation: Not tracking yet, On track, Due soon, and Ready to reconnect, with concrete timing and pause controls. Do not infer affection, closeness, or relationship quality from logging frequency.

### 8. P2: Launch assurance and capability claims remain incomplete

Current dependency audit reports 14 affected packages, including eight high and six moderate, with no critical findings. This is a dependency-graph result, not proof of 14 exploitable production vulnerabilities; build tooling is included. Existing CI fails on moderate advisories. The cloud route allowlist excludes visible cleanup/enrichment actions, and first-run copy still claims contact files are processed locally although hosted imports are processed by the server.

Evidence: [CI](/Users/fernandoamaral/Dev/Personal%20CRM/.github/workflows/ci.yml:32), [cloud routing](/Users/fernandoamaral/Dev/Personal%20CRM/middleware.ts:107), [onboarding copy](/Users/fernandoamaral/Dev/Personal%20CRM/app/page.tsx:126).

Recovery is materially improved: verified snapshots, restoration, retention and resumable erasure now exist and their cloud tests pass. Remaining gaps include the 16 MB interactive limit, no scheduled cloud backups, interrupted-operation cleanup, and authenticated browser recovery verification. Oversized operations fail safely rather than deleting without a backup, but there is no scalable fallback yet.

Evidence: [size limit](/Users/fernandoamaral/Dev/Personal%20CRM/lib/cloud/recovery-contract.ts:11), [automatic backup state](/Users/fernandoamaral/Dev/Personal%20CRM/lib/cloud/recovery-storage.ts:88), [failure cleanup](/Users/fernandoamaral/Dev/Personal%20CRM/lib/cloud/recovery-storage.ts:126).

Recommendation: triage advisory reachability and compatible upgrades; capability-driven controls and truthful hosted-mode copy; bounded background recovery; reproducible commits, migrations, cloud builds, and real authenticated journeys before public release.

## UI/UX Direction

The warm palette, readable type, rounded surfaces, and consistent components are a sound base. The largest improvement is hierarchy and ease of action, not a wholesale visual rebrand.

- **Today:** show three to five people, why now, one useful memory, and Reach out / Log / Snooze. Combine occasions and cadence without losing information. Move transfer/setup panels away from the daily screen. Opening a messaging app must not automatically count as a conversation.
- **People:** put search first and default to a compact list on phones. Show bulk actions only after selection. In the 390 x 844 preview, the first person begins around 660 pixels down; most of the initial screen is management UI.
- **Profiles:** a compact identity header and persistent Message / Log / Remind row. In the demo profile, Log is roughly 3,115 pixels below the top while Delete is near the top. Put edit/delete in an overflow menu and unify timeline/history.
- **Calendar:** agenda-first on phones, compact date navigation, collapsible filters, and a visible Add action. Event details should offer Complete / Snooze / Edit. The current mobile month grid begins near the bottom of the initial viewport.
- **Capture:** save after name plus optional contact method/note; progressively reveal other fields. Offer Person / Note / Reminder from the global Add control. Keep drafts safe without indefinitely retaining sensitive notes on shared devices.
- **Navigation:** Today, People, Calendar, Settings. Put Circles and saved lists inside People. The desktop header currently wraps the brand, Smart Lists, and Add Contact labels even in the observed wide viewport.
- **Feedback and accessibility:** persistent import reports, visible delivery/sync failures, keyboard and screen-reader journeys, zoom, reduced motion, and real iPhone Safari checks. Existing Chromium coverage is not an iOS accessibility certification.

## Concept and Priorities

Position Everclose as a **personal relationship companion**, not a sales CRM: remember what matters and follow through with the people you care about. Use Everclose as the visible product name; CRM can remain a category/domain descriptor.

The central loop should be: notice a relevant moment, act, capture one useful detail, and choose a next step. Optimize for less administration, not more stored fields. Onboarding should start with a small chosen circle rather than demand a complete address-book import.

Family context can be valuable if modeled consistently: one child/person can connect to both parents, varied relationships are supported, and reminders do not duplicate. Give users control over sensitive facts, archived relationships, and occasions they no longer want surfaced.

Build evidence-linked briefs before adding generative AI. Any later assistance should cite stored notes, distinguish stale or inferred facts, and require review before outreach. Avoid automatic messages, relationship scoring, and a decorative graph without a concrete task.

Finish authenticated cloud sync before marketing the iOS code as a companion app. Its current SQLite store and queued sync intents do not themselves provide cross-device synchronization. Prioritize the responsive web daily loop first.

Recommended sequence:

1. Finish cloud correctness, import reconciliation, conflict safety, recovery, privacy/capability copy, and dependency/build verification.
2. Ship Today, mobile People, profile quick capture, and the agenda calendar as one coherent experience.
3. Deliver reliable closed-app reminders and a configurable digest, with observable failures and quiet hours.
4. Add consented contact/calendar updates with provenance, then shared iOS data and optional grounded assistance.

Measure time to first useful follow-up, time to log a conversation, weekly meaningful actions, four/eight-week retention, dismissed reminders, unresolved duplicates, and successful restore drills. These are proposed measures, not measured results or validated target values.

## Verification and Boundaries

- Current full suite: **208/210 pass**. Two failures are in intelligence tests: one stale headline wording expectation and the birthday-context regression described above.
- Existing Cloudflare storage/runtime suite: **16/16 pass**, including recovery, retry, concurrent contact edits, and completion. These tests do not certify every visible cloud feature or the deployed OAuth path.
- ESLint and TypeScript checks pass.
- Additional disposable SQLite-backed cloud-handler reproductions confirmed dashboard placeholders, missing birthday candidates, ignored tags, incomplete search, wrong calendar day, and lost concurrent tag updates.
- Inspected current local demo UI in Chrome at desktop size and 390 x 844: dashboard, People, profile, and calendar. This is not inspection of private production contacts. The form review is source-based; a later browser navigation timed out.
- Successfully queried the current npm advisory service after retrying a sandbox network failure. No packages were changed.
- Did not run a production/cloud build, full browser suite, real iPhone tests, OAuth sign-in, live-domain security review, or remote migrations/deployment. No assertion is made that the deployed site matches this checkout or that Chrome's earlier warning is resolved.
- Existing uncommitted and untracked work was preserved. The implementation objective remains unfinished; this report is an audit checkpoint, not release approval.

**Overall judgment:** promising private beta with a useful data model and improving safety foundation. It is not yet ready for a broad public launch. Cloud reliability and an effortless daily loop matter more than adding another feature category.
