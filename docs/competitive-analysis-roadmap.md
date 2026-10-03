# Bonds Competitive Analysis and Product Roadmap

**Research date:** 12 July 2026  
**Scope:** Personal relationship management products for individuals and small relationship-driven teams.  
**Evidence standard:** Current Bonds worktree plus competitors' official product, pricing, and help pages. Vendor claims have not been independently benchmarked.

## Executive Decision

Bonds should become the **private relationship operating system for people who want useful automation without surrendering ownership of their relationship history**.

The market splits into three clusters:

1. **Automated network intelligence:** Dex and Mesh minimize data entry through email, calendar, contacts, messaging, and social sync, then layer AI and proactive context on top.
2. **Mobile capture and follow-up:** Covve and UpHabit emphasize fast capture, contact sync, reminders, introductions, and professional networking workflows.
3. **Private or flexible records:** Monica emphasizes self-hosting and rich personal/family context; folk emphasizes customizable, collaborative, sales-oriented workflows.

Bonds already has unusually strong foundations for the third cluster: local-first SQLite, self-hosting, verified backups and restore, encrypted portable backups, explicit relationships, children, detailed timelines, duplicate-safe imports, and a privacy-safe calendar. Its largest competitive weakness is not missing record types. It is **maintenance cost**: users must manually create or update most contacts and interactions, the native iOS app does not sync with web, and intelligence is generated only from data the user has already entered.

The roadmap should therefore prioritize:

1. One trusted dataset across web and iOS.
2. Opt-in contact and calendar sync with source provenance and reversible writes.
3. Capture that takes seconds: share sheet, voice, card/QR, and post-meeting prompts.
4. Private, evidence-linked briefs and natural-language retrieval.
5. Network leverage such as introductions and location views.

Team sales pipelines, mass outreach, and broad marketing automation should remain explicit non-goals until retention proves that Bonds needs a team product.

## Bonds Today

The following capabilities are implemented in the current repository, not merely planned:

- Contact profiles with nickname, birthday alert lead time, photos, work/social metadata, notes, tags, gift ideas, and custom fields.
- Bidirectional contact relationships with independent reciprocal labels, plus any number of children and birthdays.
- Calls, messages, meetups, emails, reminders, plans, facts, relationship health, smart lists, groups, and a combined timeline.
- Month and agenda calendar views for birthdays, child birthdays, reminders, plans, and interaction history, with type/contact/status/search filters.
- CSV and vCard import/export, explicit LinkedIn browser capture, duplicate discovery, and transactional merge.
- Local authentication, bounded and idempotent mutations, private photo processing, PWA installability, and browser notifications while Bonds is open.
- Automatic and pre-change SQLite snapshots, guarded restore, encrypted portable backup, and complete workspace erasure.
- An offline-first native iOS foundation with local SQLite, native contact capture, an outbox, interaction logging, and local reminders.

Important current constraints:

- Web and native iOS databases do not synchronize.
- Google, Microsoft, iCloud, email, and external calendars are not automatically read or synchronized.
- Browser notifications require Bonds to be open; there is no server push delivery.
- LinkedIn capture is explicit and profile-by-profile rather than continuous sync.
- No business-card/QR scanner, voice capture, share extension, map view, or introduction workflow exists.
- No external REST API, webhooks, Zapier/Make connector, or MCP surface exists for user data.
- Existing intelligence is deterministic and local; there is no conversational network search, pre-meeting brief delivery, or source-linked AI synthesis.

## Main Competitors

### Dex: automation benchmark

**Position:** Relationship-first personal CRM for active networkers.  
**Current strengths:** Gmail, Outlook, calendar, contact, LinkedIn, WhatsApp, iMessage, and social integrations; automatic interaction updates; keep-in-touch board; map; AI Assist; pre-meeting briefs; mobile/desktop/web; API and Zapier on its higher tier. Premium is advertised at $12/month and Professional at $20/month.

**What Bonds should learn:** A personal CRM survives only when routine interaction capture becomes nearly passive. Pre-meeting context is a high-value output because it converts stored data into an immediate real-world benefit.

**Do not copy blindly:** Deep third-party ingestion increases privacy exposure and operational dependency. Bonds should provide narrow scopes, metadata-only modes, local processing where feasible, and clear source controls.

### Mesh, formerly Clay: intelligence and ambient updates benchmark

**Position:** Automatically organized and searchable personal/professional network.  
**Current strengths:** Email, calendar, social, messaging, and contact imports; ambient job/location/news updates; reminders and reconnect prompts; Nexus natural-language network assistant; cross-platform apps; team network discovery. Personal supports up to 1,000 contacts and Pro is advertised at $10/month.

**What Bonds should learn:** Search should answer relationship questions, not only match text. A feed becomes valuable when it mixes intentional reminders with meaningful external changes.

**Do not copy blindly:** Ambient enrichment can become noisy, difficult to verify, and privacy-invasive. Every generated Bonds insight should identify its source and allow correction or dismissal.

### Monica: closest values competitor

**Position:** Open-source personal CRM for friends and family.  
**Current strengths:** Rich family context including significant others, children, and pets; activities, reminders, gifts, debts, journal, self-hosting, and a REST API. Hosted pricing is advertised at $9/month; self-hosting is free.

**What Bonds should learn:** Personal relationships need different primitives from sales relationships. Family structure, gifts, life events, and personal history are strategically meaningful, not secondary metadata.

**Where Bonds can lead:** More polished proactive views, stronger safety/recovery, a native client, calendar synthesis, duplicate-safe portability, and opt-in automation without abandoning self-hosting.

### Covve: mobile capture benchmark

**Position:** Mobile-first personal CRM and professional lead-capture suite.  
**Current strengths:** Smart reminders, interaction notes, network analytics, contact news, business-card/event-badge/QR scanning in 60+ languages, offline capture, voice capture, AI research, digital business cards, custom fields, and CRM export/sync.

**What Bonds should learn:** The moment immediately after meeting someone is the highest-leverage capture point. Voice and camera input are more important on mobile than reproducing every desktop management screen.

**Do not copy blindly:** Bonds should optimize for remembered relationships, not conference lead qualification or company-owned lead collection.

### UpHabit: follow-up and introductions benchmark

**Position:** Mobile personal CRM oriented toward professionals and business networks.  
**Current strengths:** Automatic contact gathering from device contacts, calendars, sent mail, Google, and Microsoft; configurable reminders; notes and tags; quick introductions; integrations with Salesforce, Constant Contact, and Mailchimp. Its business plan is advertised at $119.99/year or $19.99/month.

**What Bonds should learn:** Facilitating a warm introduction is a concrete relationship outcome, and recurring check-in cadences should be operational rather than merely descriptive.

### folk: collaboration and workflow benchmark

**Position:** Lightweight collaborative CRM for sales, partnerships, agencies, and startups.  
**Current strengths:** Shared pipelines, people and companies, enrichment, LinkedIn extension, email/calendar/WhatsApp sync, campaigns and sequences, AI fields and assistants, dashboards, custom objects, API, and thousands of integrations. Standard is advertised at $24/member/month annually.

**What Bonds should learn:** Flexible views, automation surfaces, and relationship intelligence become important if the product expands to professional teams.

**Why it is not the immediate target:** Pipelines, campaigns, permissions, and deals would pull Bonds toward a crowded team CRM market and conflict with its current personal, private-first advantage.

## Feature-Gap Matrix

Legend: **Strong** = central, evidenced capability; **Partial** = limited/manual/tier-dependent; **No** = explicitly absent or no current implementation; **N/E** = not evidenced in reviewed first-party material.

| Capability | Bonds | Dex | Mesh | Monica | Covve | UpHabit | folk |
|---|---|---|---|---|---|---|---|
| Rich personal contact records | Strong | Strong | Strong | Strong | Strong | Strong | Strong |
| Explicit family/relationship graph | Strong | Partial | Partial | Strong | Partial | N/E | Partial |
| Children and personal life context | Strong | N/E | N/E | Strong | N/E | N/E | N/E |
| Interaction timeline | Strong, manual | Strong, auto | Strong, auto | Strong, manual | Strong, app-led | Partial | Strong, synced |
| Keep-in-touch cadence | Strong | Strong | Strong | Strong | Strong | Strong | Partial |
| Unified relationship calendar | Strong | Partial | Partial | Partial | Partial | Partial | Synced calendar |
| Contact sync | No | Strong | Strong | No | Strong | Strong | Strong |
| Email/calendar auto-capture | No | Strong | Strong | No | Partial | Strong | Strong |
| Social/messaging sync | Explicit LinkedIn capture | Strong | Strong | No | Partial | N/E | Strong |
| Card/QR capture | No | Strong | Strong | No | Strong | N/E | Mobile capture |
| Voice capture | No | Strong | Partial | No | Strong | N/E | N/E |
| Natural-language network search | No | AI-assisted | Strong | No | AI research | No | AI assistants |
| Pre-meeting brief | No | Strong | AI-assisted | No | Partial context | No | AI-assisted |
| Job/news/life-change signals | No | Strong | Strong | No | Strong | N/E | Enrichment |
| Map/location view | No | Strong | N/E | No | N/E | N/E | N/E |
| Warm introductions | Relationship data only | Partial | Team paths | No | N/E | Strong | Team paths |
| Duplicate-safe import/merge | Strong | Strong | Strong | Import/export | Strong | Partial | Strong |
| Public API/automation | No | Paid | Integrations | Strong | Integrations | Business integrations | Paid |
| Team collaboration/pipeline | No | No | Paid teams | No | Team capture | Business | Strong |
| Self-hosting/local ownership | Strong | No | No | Strong | No | No | No |
| Verified local recovery | Strong | N/E | N/E | User-operated | N/E | N/E | N/E |
| Native mobile | Foundation only | iOS/Android | iOS/Android | No official native app evidenced | iOS/Android | iOS/Android | Mobile app |

## Strategic Gap Assessment

### Critical gaps

#### 1. One dataset across devices

The native app and web app currently form separate products. Until they share a trusted data model, the native experience cannot become the default capture surface and users face inconsistent reminders and histories.

**Opportunity:** Make a user's self-hosted Bonds instance the sync authority, with device-local caches and an auditable outbox. This preserves ownership while delivering cross-device continuity competitors already provide.

#### 2. Automatic but reversible context capture

Dex, Mesh, folk, and UpHabit reduce upkeep by reading calendars, email metadata, or contacts. Bonds requires manual interaction logging.

**Opportunity:** Begin with the least sensitive, highest-value sources: device contacts and calendar attendee metadata. Preserve source IDs, permission scopes, sync timestamps, and a reversible import ledger. Email body ingestion should not be the first integration.

#### 3. Reliable delivery outside an open browser

Current browser alerts are privacy-safe but require Bonds to be running. This weakens the core promise of timely follow-up.

**Opportunity:** Use native local notifications for synchronized reminders first. Add optional web push later, with no relationship detail in lock-screen payloads by default.

#### 4. Mobile capture speed

The mobile foundation supports manual contact and interaction entry but lacks card scanning, QR capture, voice notes, share-sheet capture, and post-call/post-meeting prompts.

**Opportunity:** Treat mobile as an input instrument, not a smaller admin interface.

### High-value differentiation gaps

#### 5. Private pre-meeting brief

Bonds already has the necessary source data model: contact details, facts, plans, notes, interactions, relationships, and calendar events. It lacks the just-in-time synthesis and delivery that Dex demonstrates.

**Opportunity:** Generate an evidence-linked brief locally or through a user-configured model. Start deterministic, then add optional AI rewriting. Never invent facts; every statement should link to a record or source.

#### 6. Relationship-aware search

Current search finds contacts and text. It cannot answer “Who do I know in Berlin?”, “Who introduced me to Ana?”, or “Who has a birthday before my trip?”

**Opportunity:** Build structured query primitives first, then a natural-language planner over those deterministic tools. This is safer and more useful than a free-form chatbot over raw notes.

#### 7. Introductions and graph utility

Bonds can now represent contact-to-contact relationships but does not use them for discovery or action.

**Opportunity:** Add relationship paths, mutual connections, introduction history, suggested introducers, and a guided introduction workflow. This turns the newly built graph into user value.

### Lower-priority gaps

- Map view for trip planning and local meetups.
- Job-change and public-news signals with explicit subscriptions.
- Digital business card and contact exchange.
- Templates and lightweight automations.
- Team collaboration, shared pipelines, campaigns, and permissions.

## Priority Scorecard

Scores use **user impact**, **privacy/positioning fit**, and **dependency leverage** on a 1-5 scale. Effort is relative, where 5 is largest. Priority reflects product sequencing rather than a mechanical sum.

| Initiative | Impact | Privacy fit | Dependency leverage | Effort | Priority |
|---|---:|---:|---:|---:|---|
| Web/iOS sync and conflict safety | 5 | 5 | 5 | 5 | P0 |
| Guided import and activation | 5 | 5 | 4 | 2 | P0 |
| Native reminder delivery and controls | 5 | 5 | 4 | 3 | P0 |
| Calendar quick actions and source deep links | 4 | 5 | 3 | 2 | P0 |
| Device/Google contact sync with provenance | 5 | 5 | 5 | 4 | P1 |
| Calendar metadata ingestion and event matching | 5 | 4 | 5 | 4 | P1 |
| Share sheet, QR/vCard, and post-event capture | 4 | 5 | 4 | 3 | P1 |
| Deterministic pre-meeting brief | 5 | 5 | 3 | 3 | P2 |
| Structured and natural-language network search | 4 | 5 | 3 | 4 | P2 |
| Voice and card OCR capture | 4 | 4 | 2 | 4 | P2 |
| Mutual paths and introduction workflow | 4 | 5 | 2 | 3 | P2 |
| Scoped API, webhooks, and MCP | 3 | 4 | 3 | 4 | P3 |
| Location/travel view | 3 | 5 | 1 | 2 | P3 |
| Job/news change signals | 3 | 2 | 1 | 5 | P3 |
| Team pipelines and campaigns | 2 | 1 | 1 | 5 | Defer |

## Prioritized Roadmap

The phases are dependency-based horizons, not calendar commitments. Each phase should ship behind observable outcomes before the next expands scope.

### Phase 0: Cohesive private product (0-6 weeks)

**Goal:** A new user can trust Bonds, import their network, and use the same relationship data on phone and web.

1. **Web/native sync contract**
   - Stabilize shared UUIDs, revision vectors, tombstones, conflict rules, and idempotent outbox replay.
   - Make the self-hosted web instance the default authority; keep encrypted device-local storage.
   - Add sync status, last successful sync, conflict review, and export-before-reset safeguards.
2. **Guided activation**
   - Add a first-run flow for vCard/CSV/device contacts, duplicate preview, key relationships, notification permission, and first keep-in-touch cadence.
   - Explain local ownership and backup status during setup instead of burying it in settings.
3. **Reliable reminders**
   - Synchronize reminders to native local notifications.
   - Add snooze, reschedule, recurring cadence, quiet hours, and privacy-redacted notification text.
4. **Calendar action loop**
   - Add quick creation/editing from a calendar day and deep links from events to the source reminder, plan, or interaction.

**Exit evidence:**

- At least 70% of activated users import or create 20 contacts.
- At least 60% create one cadence/reminder and log one interaction in the first session.
- Web/native sync completes without unresolved loss in automated conflict and offline replay tests.
- Median time from install to first useful Today feed is under five minutes.

### Phase 1: User-controlled autopilot (6-12 weeks)

**Goal:** Reduce weekly maintenance without compromising inspectability.

1. **Contact sync adapters**
   - iOS Contacts first, then Google Contacts; Microsoft after demand is validated.
   - Field-level provenance, one-way/read-only default, explicit two-way opt-in, dry-run preview, and reversible batches.
2. **Calendar ingestion**
   - iOS Calendar and Google Calendar attendee/event metadata.
   - Match attendees to contacts, suggest rather than silently create interactions, and expose ignored calendars.
3. **Post-event capture**
   - After a matched meeting, prompt for a short note, next step, and follow-up date.
   - One-tap “met”, voice dictation, and offline queueing.
4. **Capture extensions**
   - iOS share extension for links/contact cards, QR/vCard camera import, and a generalized browser capture contract beyond LinkedIn.

**Exit evidence:**

- Synced users perform at least 50% fewer manual contact updates.
- Suggested interaction matching reaches at least 95% precision before auto-log is offered.
- More than 35% of matched meetings receive a note or next action.
- Every imported field can be traced to and removed with its source.

### Phase 2: Private relationship intelligence (3-5 months)

**Goal:** Turn stored context into timely, trustworthy help.

1. **Deterministic pre-meeting brief**
   - Upcoming event, attendees, last contact, open plans/reminders, recent notes, family/context facts, and suggested questions.
   - In-app and native delivery first; optional email delivery later.
2. **Natural-language retrieval**
   - Tool-based queries over contacts, relationships, dates, tags, locations, history, and plans.
   - Show query interpretation and evidence; no answer when evidence is insufficient.
3. **Optional private AI layer**
   - User-selectable local model or bring-your-own API provider.
   - Redaction controls, per-feature consent, data preview, no training claim, and deterministic fallback.
4. **Voice and card capture**
   - On-device OCR where practical, review-before-save, source image disposal by default, and voice-to-structured-note.
5. **Relationship graph utility**
   - Mutual contacts, shortest trusted path, introduction records, and guided intro drafting.

**Exit evidence:**

- Briefs are opened for at least 40% of eligible meetings.
- Fewer than 2% of surfaced brief facts are marked incorrect.
- Natural-language queries return cited deterministic results for the supported query set.
- Median new-contact capture time falls below 30 seconds.

### Phase 3: Network awareness and extensibility (6-9 months)

**Goal:** Keep the network current and let advanced users extend Bonds safely.

1. **Location and travel view** using explicit contact location data, with no background location tracking.
2. **Subscribed change signals** for selected contacts: job changes, location changes, and news, with source links and dismiss controls.
3. **Automation surface:** scoped REST API, outbound webhooks, import connectors, and an MCP server with read-only default permissions.
4. **Rule builder:** examples include “after a meetup, remind me in 30 days” and “show birthdays two weeks before travel.”
5. **Android decision:** build native Android only after iOS sync/capture retention materially exceeds the responsive PWA baseline.

**Exit evidence:**

- Change signals maintain an acceptable relevance/dismissal ratio established during beta.
- API tokens are capability-scoped, revocable, logged, and excluded from backups by default.
- Automation failures are visible, retryable, and cannot silently duplicate records.

### Phase 4: Optional professional expansion (9-12+ months)

Only enter this phase if solo-user retention is strong and interviews show repeated demand for collaboration.

- Selective relationship sharing rather than a globally shared address book.
- Introduction requests and warm-path discovery across trusted workspaces.
- Lightweight shared projects or relationship goals, not a generic deal pipeline.
- Fine-grained permissions, sensitive-interaction controls, audit logs, and data residency before team launch.

## Explicit Non-Goals for the Next 9 Months

- Sales forecasting, revenue reporting, and generic deal pipelines.
- Bulk cold outreach, email tracking pixels, or marketing sequences.
- Silent ingestion of email bodies or messages.
- Scraping social networks in ways that are brittle or violate platform terms.
- AI-generated relationship facts without a reviewable source.
- Cloud-only architecture that removes self-hosting or portable export.

## Build Order and Dependencies

```text
Shared identity + revisions
        |
        v
Web/iOS sync --> native notifications --> fast mobile capture
        |
        v
Source provenance --> contacts/calendar adapters --> suggested interactions
        |
        v
Deterministic briefs + structured search
        |
        v
Optional AI synthesis --> graph/introduction tools --> change signals/API
```

Do not build AI briefs before provenance and sync. Otherwise Bonds will summarize stale or duplicated data and undermine the trust advantage it is meant to protect.

## Product Metrics

### North-star metric

**Meaningful relationship actions completed per weekly active user:** logged interaction, completed follow-up, prepared meeting, remembered occasion, or facilitated introduction. Raw contacts stored and notifications sent are not outcomes.

### Supporting metrics

- Activation: imported/created contacts, first cadence, first interaction, first reminder completed.
- Maintenance burden: manual edits and minutes spent per 100 active contacts.
- Trust: sync conflicts, restore success, incorrect brief facts, dismissed signals, permission revocations.
- Retention: week 4 and week 12 active use segmented by manual-only versus synced users.
- Relationship outcomes: overdue cadence recovered, meeting notes captured, introductions completed.
- Privacy: percent of users choosing local-only, metadata-only, or external processing modes.

## Research Sources

Primary sources reviewed on 12 July 2026:

Internal implementation evidence:

- [Current product overview](../README.md)
- [Explicit integration boundary](../lib/data-capabilities.ts)
- [Web database schema](../lib/database-schema.ts)
- [Calendar aggregation](../lib/calendar-directory.ts)
- [Contact relationships and children](../lib/contact-connections.ts)
- [Native iOS status and limitations](../apps/mobile/README.md)
- [Native sync boundary](../apps/mobile/docs/architecture.md)

Competitor evidence:

- [Dex pricing](https://getdex.com/pricing/)
- [Dex integrations](https://getdex.com/integrations/)
- [Dex Google sync documentation](https://getdex.com/docs/integrationsandfeatures/syncfeatures/sync-google)
- [Dex pre-meeting brief documentation](https://getdex.com/docs/workflows/pre-meeting)
- [Dex core features](https://getdex.com/docs/dex-core)
- [Mesh product](https://me.sh/)
- [Mesh pricing](https://me.sh/pricing)
- [Monica features](https://www.monicahq.com/features)
- [Monica pricing](https://www.monicahq.com/pricing)
- [Covve personal CRM](https://covve.com/personal-crm)
- [Covve capture product](https://covve.com/individual)
- [Covve feature index](https://help.covve.com/help/features)
- [UpHabit product](https://uphabit.com/)
- [UpHabit pricing](https://uphabit.com/pricing/)
- [folk pricing and feature matrix](https://www.folk.app/pricing)
