# Development handoff — 5 October 2026

Everclose's personal web release is deployed at everclosecrm.com. Personal iOS build 3 is signed and installed on TIE Fighter. The device and simulator Release binaries, native linkage verification and isolated first launch with SQLite/Keychain initialization pass in [run 37263450401](https://github.com/Temaki-AI/relationship-manager/actions/runs/37263450401). The exact binary sources, hash, installation evidence and remaining checks are in the [personal iOS release record](personal-ios-release.md).

## Delivered personal iOS implementation

- Real Google account sign-in and account-isolated synchronization with the hosted CRM; existing 12-contact workspace was verified on the preceding installed build.
- Today, People, profiles, notes, interactions, relationship/family details, plans and reminders, with durable offline changes, draft recovery, paged history and explicit conflict review.
- Hosted-photo downloads, bounded account-local cache, native system-photo selection, explicit preview/save/removal, offline photo drafts and a durable upload queue. Lost acknowledgements retry the same operation; changed cloud photos require review.
- Reviewed iPhone Contacts capture and linking, optional consented reads and source sharing; saved Google Calendar context and native agenda/association forms.
- Reviewed Apple Calendar editor actions and durable creation receipts, with separate optional read access/date following. Real physical Calendar behavior remains unverified.

The photo API is deployed in Worker `f300697b-8aa5-46c8-b556-fc00144725d4`.
Readiness is healthy; an unauthenticated photo POST returns 401. No photo schema
migration is introduced: mobile remains schema 14 and cloud migrations remain 44.

## Verification

All **814 root tests**, five native package tests, five native-picker fixtures,
native/root TypeScript and lint checks, release export and cloud build pass.
The **15 complete photo journeys pass against real D1**, covering durable offline
uploads, conflicts, exact retry, merge/recovery, account fences and transaction
rollback. Both native jobs pass; cloud CI validation passes. General CI validation
fails at `npm audit --audit-level=moderate`; dependency security work remains open.

Build 2 was withdrawn after an actual ExpoFileSystem/Core Swift ABI mismatch in
both device and simulator binaries. Build 3 compiles all iOS Expo modules against
matching sources. Its linkage gate rejects the actual invalid binary and runs
before native artifact upload and local signing. Fresh CI startup succeeds and its
screenshot shows the Google sign-in welcome screen. Development signing keys stay
local; private packages and receipts are ignored by Git.

The preceding phone database was preserved exactly through rollback, including
all 12 contacts and original tables/fields. A fresh post-build-3 database comparison
is unverified: automatic approval review rejected the private contact-database
copy, and explicit authorization is pending. Physical post-upgrade launch, photo
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

The [Gmail metadata implementation](gmail.md) now includes separate owner consent,
dedicated client validation, encrypted grant lifecycle and an explicit read-only
mailbox-label preview. Eight consent/lifecycle journeys pass against isolated D1,
and migration 45 preserves every existing table and field. Root TypeScript/lint,
all 814 root tests, standalone/Cloudflare builds and all 16 targeted desktop/mobile
browser journeys pass. Migration 45 is applied only to isolated local D1.
Mailbox labels are temporary;
message staging, reviewed matching, web/native relationship context and real-account
OAuth remain required. No production Gmail read or deployment is implied. The
source requires migration 45 before a future deploy; live production still has
migration 44, and mobile remains schema 14.
