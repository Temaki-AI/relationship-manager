# Development handoff — 5 October 2026

Everclose's personal web release is deployed at everclosecrm.com. Personal iOS build 4 is signed and installed on TIE Fighter; the actual receipt and installed-app metadata confirm it. Both native Release binaries, linkage verification and isolated first launch with SQLite/Keychain initialization pass in [run 37278926485](https://github.com/Temaki-AI/relationship-manager/actions/runs/37278926485). Exact source, hash, installation evidence and remaining checks are in the [build-4 release record](personal-ios-build4.md). After the owner unlocked the phone, build 4 launched as process 8278 and remained running. Owner confirmation of the UI and contacts remains pending.

## Delivered personal iOS implementation

- Real Google account sign-in and account-isolated synchronization with the hosted CRM; existing 12-contact workspace was verified on the preceding installed build.
- Today, People, profiles, notes, interactions, relationship/family details, plans and reminders, with durable offline changes, draft recovery, paged history and explicit conflict review.
- Hosted-photo downloads, bounded account-local cache, native system-photo selection, explicit preview/save/removal, offline photo drafts and a durable upload queue. Lost acknowledgements retry the same operation; changed cloud photos require review.
- Reviewed iPhone Contacts capture and linking, optional consented reads and source sharing; saved Google Calendar context and native agenda/association forms.
- Reviewed Apple Calendar editor actions and durable creation receipts, with separate optional read access/date following. Real physical Calendar behavior remains unverified.
- Safe startup recovery for database, Keychain identity and account-cache failures, preserving the original account cache, drafts and queued edits.

The photo API is deployed in Worker `f300697b-8aa5-46c8-b556-fc00144725d4`.
Readiness is healthy; an unauthenticated photo POST returns 401. No photo schema
migration is introduced: mobile remains schema 14, production remains migration 44
and local cloud development now has migration 47.

## Verification

All **820 root tests**, **152 native behavior tests**, five native package tests, five native-picker fixtures,
native/root TypeScript and lint checks, release export and cloud build pass.
The **15 complete photo journeys pass against real D1**, covering durable offline
uploads, conflicts, exact retry, merge/recovery, account fences and transaction
rollback. The full D1 suite passes 354 tests, with nine large-count and two trigger-fault cases covered by
SQLite. Both native jobs pass; cloud CI validation passes. General CI validation
fails at `npm audit --audit-level=moderate`; dependency security work remains open.

Build 2 was withdrawn after an actual ExpoFileSystem/Core Swift ABI mismatch in
both device and simulator binaries. Build 3 compiles all iOS Expo modules against
matching sources. Its linkage gate rejects the actual invalid binary and runs
before native artifact upload and local signing. Fresh CI startup succeeds and its
screenshot shows the Google sign-in welcome screen. Development signing keys stay
local; private packages and receipts are ignored by Git.

The preceding phone database was preserved exactly through rollback, including
all 12 contacts and original tables/fields. A fresh post-upgrade database comparison
is unverified: automatic approval review rejected the private contact-database
copy, and explicit authorization is pending. Build 3's process launch and stability
passed; build 4's launch and process-stability checks now pass after the owner unlocked it. Physical
build-4 UI/data, photo
selection/rendering, phone-edit/web round trips, closed-app reminder delivery,
Calendar permission/editor journeys and broader accessibility remain unverified.

## Remaining integration and public-release work

1. Configure separate Google Contacts/Calendar clients and credential vault, then verify real consent, recurring reconciliation and publishing. Google endpoint tests use fixtures; account sign-in does not establish data-integration readiness.
2. Complete the real iPhone Contacts/Calendar and offline-to-web pilot, including reminder delivery, accessibility, timezone/identity changes and recovery.
3. Resolve shared Google/EventKit publication identity and cross-provider duplicate prevention. Offline local guards alone cannot guarantee a global reservation.
4. Implement Gmail context. LinkedIn currently supports reviewed profile URLs/export imports; continuous LinkedIn account synchronization is unavailable.
5. Complete Sign in with Apple/account management, dependency security, public provider approvals, TestFlight/App Store distribution, operational checks and the daily-use pilot.

Local development OAuth still needs its own configured credentials. The shared
local Simulator belongs to another active project; permission to switch it remains
pending. The installed personal build and successful isolated CI simulator do not
complete the integrated personal beta or public release.

The saved Gmail stash `3473e7443855718e3aaee489d4ce1aa739add78e` has been restored
and extended into the current download implementation; do not apply it again to
this checkout. It remains as a historical backup. Migration 47 is applied to local
D1 only. No Gmail download/matching or migration 45–47 is deployed to production. Mobile
dependencies are present; the signed phone binary remains its separately verified
build-4 source.

## References

- [Full product development plan](product-development-plan.md)
- [Implementation history](implementation-roadmap.md)
- [Development setup](development.md)
- [Contact synchronization](contact-sync.md)
- [Google connections](google-connections.md)
- [Google Calendar](google-calendar.md)
- [Apple Calendar](apple-calendar.md)
- [LinkedIn imports](linkedin-import.md)

## Continuing integration/security work

Compatible dependency patches remove four root and seven mobile reported package
findings; audits remain failing for the explicitly recorded unresolved packages.
Native source validation/export passes with unchanged framework versions. The
complete source suite and Cloudflare build pass (805/805 tests) with bounded
concurrency; the initial
run exhausted local disk and a sandboxed retry could not bind fixture servers,
so the final complete run used two workers with fixture-only localhost access. See
[dependency security](dependency-security.md) for exact versions and remediation
limits. Both patched-dependency native Release builds and isolated first launch
also pass in [run 37267403749](https://github.com/Temaki-AI/relationship-manager/actions/runs/37267403749).
The installed build 3 retains its separately recorded source and signing evidence.

The [Gmail implementation](gmail.md) now includes reviewed labels/aliases, default-off
subjects, bounded retention, durable full/incremental downloads, atomic publication,
reviewed matching and per-person web metadata context. Existing/later-created
contacts match exact retained email methods without another provider read. Shared
addresses, exclusions, changed identities, merges and exact review retries are
covered. All 853 root tests and 20 desktop/mobile Gmail browser journeys pass, with
TypeScript/lint and standalone/Cloudflare builds. The 38 focused checks include
34 disposable D1 tests, three prior-data SQLite migration checks and pure matching
rules. Mobile rendering, WCAG and viewport checks pass. General profile/native
correspondence, cross-account/activity review and consented recurring jobs remain
engineering work. Real clients/vault and a controlled mailbox pilot remain required.
Readiness requires migrations 45–47 before any source deploy; production was last
verified at migration 44, local D1 has 47, and mobile remains schema 14.
