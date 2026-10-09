# Calendar server rollout

Status on 6 October 2026: the Calendar-only server is deployed as Worker
`ac198899-e378-48d1-b9c4-3fea9a83d436`. The exact signed build 12 is installed in
place on TIE Fighter and runs in the user-ready simulator. Fresh phone metadata
confirms 1.0.0/build 12; physical launch is held by the device lock. Native Release,
startup and offline tests pass in CI 37402857771. The simulator welcome screen is
inspected, its original 23 data tables and identity values are retained through
schema 16-to-18, and integrity/foreign keys pass.

The server source is `d8fb137eb1096203f743dfb7c91a71718f1fab99` on
`codex/calendar-publication-server`. It starts from the preceding live source
`d741d51921d7686ef9379e1476e75bb9c5ed3717` and Worker
`370949af-afef-44e2-8578-900625e1ce0d`. Calendar API, shared plan guards, domain
protocol and migrations match native source
`3c5e6cce21889aded7ce6e4cacef722c3461ff85`. The exact authenticated route,
schema declarations and workspace erasure cover the new receipts. Native clients
retain core sync protocol 4. Existing Today/photo routes and Worker resource
configuration are preserved. The compiled entry and handler hashes match the
preflight receipts before deployment.

Only the original migrations `0049_calendar_publication_reservations.sql` and
`0050_calendar_publication_reviews.sql` and their journal entries were applied.
Gmail migrations 45–48, handlers, queues and data consent remain a separate
rollout. The limited server readiness requires migration 50; the full development
branch separately requires both migrations 48 and 50. This deployment does not
include the newer web Calendar rescheduling UI from the development branch.

The owner explicitly approved saving the full live database, including contacts,
notes and account records, at
`/private/tmp/everclose-calendar-production-before-20261006.sql`. It is 498,915
bytes, mode 0600, SHA-256
`69bbd2a5f30a429e0d60d5586cb7537b367c7bbced561827e5862f438a485593`.
The raw backup remains at that approved destination, outside Git and release
artifacts. The private rehearsal applies the two exact migrations, compares every
original field across 69 tables, and passes integrity and foreign keys. Its 29
contacts are an aggregate across all workspaces, not the owner's contact count.
No personal phone database was copied or reset.

The standard Wrangler migration command and then the REST statement batch each
reject compound trigger SQL with `incomplete input`. Read-only checks after each
failure confirm no new Calendar table or journal entry. D1's file-import path
successfully executes the unchanged original SQL plus the two journal inserts:
20 queries, final bookmark
`000003f3-0000000e-000050fc-d47c190d0a95ac80c658ae52a59e2e9e`.
Future operational use must preserve full trigger statements and check the journal
before retrying an uncertain migration; do not blindly repeat the import.

Post-migration read-only comparisons confirm every original row is unchanged
across all 69 tables. Large values use parameterized queries within D1's limits,
returning only mismatch counts. Both journal entries, foreign keys and quick-check
pass. Live readiness returns 200/ready with schema current and Google
identity authentication configured. Native Calendar and core sync endpoints
return 401 without authentication; the existing signed-in web session opens Today.
Real Google data consent and provider effects are not established by these checks.

Preflight verification remains 814 server cases collectively, 31 selected Calendar
and three Today cases against real disposable D1, types, full lint, Cloudflare
compilation and Worker dry run. The initial harness-alias failure and repaired
checks remain recorded. No real-provider pilot, phone/web owner round trip or
completed integrated beta is implied.

Private delivery receipts are in the ignored
`apps/mobile/build/releases/build12-personal-delivery/` directory, including
migration/deployment results, field-preservation summaries, filtered installed
app metadata and simulator preservation. They contain no raw production backup.
The backup, private rehearsal and preceding Worker version provide recovery
evidence. The preceding Worker can run with these additive Calendar tables; a
rollback must retain new receipts rather than restore an old database over newer
CRM writes without a fresh review.
