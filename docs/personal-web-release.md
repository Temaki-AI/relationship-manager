# Everclose personal web release — 4 October 2026

The working web release is deployed at **https://everclosecrm.com**. It uses the existing Google sign-in and production contact database. This is the usable web milestone; it is not completion of the integrated beta or native iOS distribution.

## Release evidence

- Cloudflare Worker version: `4222b1a6-c7ba-47e1-b8cb-3f78adeaff17`.
- The 5 October photo-download update is deployed as `2b5e42b8-b888-4c3c-afbb-16c547a12a8f`.
  It adds a bounded UUID-based read endpoint for the native device credential,
  without a database migration. Live readiness is healthy and unauthenticated
  photo access returns 401. Its matched signed iPhone update is installed; all 783
  regression tests and seven photo/recovery tests against real D1 pass.
- D1 migrations applied through `0044_calendar_plan_publications.sql`.
- Production readiness: HTTP 200, `ready: true`, Google authentication and current schema.
- Unauthenticated contact access: HTTP 401.
- Real Google sign-in succeeded. The owner's signed-in People directory displays 12 contacts; the database retains 26 across its two workspaces.
- Live People, an existing contact profile and its populated edit form load successfully. At 390-pixel iPhone width, the edit form and Calendar have no error alerts or horizontal overflow; Calendar uses its responsive Agenda view.
- Live Data & recovery loads without errors or horizontal overflow. Creating an in-app manual backup succeeded; Settings shows the current 12-contact recovery point, 62.7 KB and its SHA-256 checksum, alongside the retained prior backup.
- A real pre-release database copy passed all 21 pending migrations in isolation. Original fields were preserved across all original tables, except the expected monotonic recovery counter. After the production upgrade, 33 original data tables match their pre-release field hashes, including contacts, notes, photos, relationships and history. Operational authentication tables were excluded from the production comparison because sign-in refreshes them.
- The prior complete root run passed 756 tests. A further 33 core synchronization tests, final Cloudflare build, TypeScript and the release script's lint pass.

Private SQL backups, the recovery bookmark and preservation reports are saved under `.wrangler/releases/2026-10-04/`, outside Git. Do not upload or commit that directory. The prior Worker version is `a0a51687-c80c-407c-a097-8fb98e1b640d`.

## Available scope

The existing core web CRM and responsive phone-browser experience use real account data. This build also contains multiple contact methods, reviewed LinkedIn export/profile linking, revocable phone sessions and the implemented Contacts/Calendar integration interfaces.

Google identity sign-in is configured. The separate Contacts, Calendar-reading and Calendar-publishing clients and connector encryption key are not configured in production. Their controls show unavailable setup and cannot obtain data access until those credentials are supplied. Gmail integration is not included. Automatic backups, email delivery and large recovery remain disabled.

## Local and native work remaining

Local Google credentials are still missing. The exact localhost client is prepared in Google Cloud; creating it and saving its persistent credential requires the owner's pending confirmation. Local storage is isolated, so local sign-in alone will not copy production contacts.

The [personal iOS release](personal-ios-release.md) has now been compiled with Xcode
26.4.1 on GitHub and installed on the owner's paired iPhone. Native sign-in and the
first sync pass cache verification with all 12 original contacts and notes.
A physical phone edit/web round trip remains. TestFlight, actual provider consent
and the full integration pilot remain separate milestones in the [product plan](product-development-plan.md).

## Migration execution note

The standard remote migration command applied migrations 24–31, then failed while parsing migration 32 as a multi-statement query. The remaining 13 original SQL migrations and their journal entries were successfully applied through Cloudflare's atomic SQL-file import. The post-upgrade foreign-key check is clean and all original CRM values match the backup. The original migration files were not changed.

Cloudflare documents both [migration management](https://developers.cloudflare.com/d1/reference/migrations/) and [SQL import](https://developers.cloudflare.com/d1/best-practices/import-export-data/). A future release should first rehearse its pending SQL against a private copy using `scripts/check-release-upgrade.mjs`; do not blindly retry a partially completed remote migration run.

The final version also corrects the old integration message that described reviewed imports as still in development. The existing capability check and lint pass, and the rebuilt Worker is deployed as the version above. The initial working deployment was `deb442e1-bc9d-4eb2-aa3b-ac06bd3b1036`.
