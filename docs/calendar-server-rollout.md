# Prepared Calendar server rollout

Status on 6 October 2026: a Calendar-only candidate is prepared in the restored
managed `shared-prompt-rollout` worktree. Production remains unchanged at Worker
`370949af-afef-44e2-8578-900625e1ce0d`, migration 44. Native build 12 is being
compiled separately in CI 37402857771; build 10 remains installed.

The server candidate starts at the actual deployed source
`d741d51921d7686ef9379e1476e75bb9c5ed3717`. Its Calendar API, shared plan guards,
domain protocol and migrations are taken from release source
`3c5e6cce21889aded7ce6e4cacef722c3461ff85`. It adds the exact authenticated route,
schema declarations and complete workspace erasure for the new receipts. Native
clients retain core sync protocol 4. Existing Today and photo routes stay available.

Only migrations `0049_calendar_publication_reservations.sql` and
`0050_calendar_publication_reviews.sql` are pending in this candidate. Their
original SQL is unchanged. The deployment-specific Drizzle snapshots describe the
actual migration-44 baseline plus those two tables; no Gmail tables are included.
Gmail migrations 45–48, handlers, queues, credentials and data consent are a
separate rollout. Existing Worker resource configuration is byte-for-byte unchanged.
The candidate's readiness requires migration 50. The full release branch requires
both Gmail migration 48 and Calendar migration 50, so the limited rollout cannot
mistakenly establish readiness for that larger Worker.

All 814 server regression cases pass collectively: the initial full run passes
813 and an existing Today case fails because the copied test harness omitted its
old routing aliases. Restoring those aliases yields three passing Today cases;
the original failure remains recorded. All 31 selected Calendar cases and all
three existing Today cases pass against real disposable D1. Full lint, final
types, Cloudflare compilation and Worker dry run pass. These are disposable
synthetic checks, not an authenticated production owner pilot.

A read-only inventory confirms migration 44, 29 contacts, three plans, six
interactions and no Google Calendar publications across the entire live database.
These are aggregate counts, not the owner's contact count or field-continuity
proof. No personal rows, secrets or phone database have been copied.

Automatic approval review rejected exporting the full production database because
the chat does not explicitly authorize copying that sensitive payload to this
Mac. The pending permission request identifies its contents and private destination:
`/private/tmp/everclose-calendar-production-before-20261006.sql`. No export or
production migration/deployment has occurred. Rehearsal against a fresh recoverable
production copy remains required before applying this candidate.

After explicit backup permission: export with private file permissions, rehearse
the two original migrations using `scripts/check-release-upgrade.mjs`, compare all
original rows, validate foreign keys/integrity and retain recovery evidence. Apply
the exact verified migrations with their journal entries, compare original CRM
values again, then deploy the verified compiled Worker and inspect live readiness,
login and endpoint authentication. Verify compatible native artifacts before
upgrading the personal installation; opening the phone requires an unlocked device.
No real provider pilot, owner round trip or completed integrated beta is implied.
