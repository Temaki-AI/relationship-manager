# Development handoff — 5 October 2026

Everclose's personal web release is deployed at everclosecrm.com. Personal iOS
**build 8** is signed, installed in place and running on TIE Fighter (1.0.0/build 8,
process 14545). Installation, fresh metadata, launch and subsequent process
stability pass. The **Everclose Build 8** simulator runs the unmodified compiled
release at welcome, with its original empty schema-15 cache and installation
identity. The separate synthetic QA simulator is shut down with its four guarded people and the schema-16 shared-prompt preview.
[The build-8 record](personal-ios-build8.md) preserves source, checksums and receipts.

Native Today has a per-person queue, combined reasons/latest history and explicit
Reach out/Log/Done/Snooze actions. Choice pickers scroll with persistent Cancel and
close when backgrounded or locked. Standard Apple method labels display clearly
while stored/raw/custom values are preserved. Native CI 37371940722 passes both
Release binaries, linkage/startup and the complete offline journey (329.156 seconds,
one test, zero failures/skips). Actual compiled build-8 background/largest-text
checks also pass; the picker screenshot was inspected. All 21 QA data tables are
unchanged, with only the existing installation marker's refresh timestamp updated.
Earlier action/restart preview evidence remains distinct in [Native Today](native-today.md).

All 898 root cases are verified collectively: 896 in the restricted full run and
two loopback-server cases in their permitted rerun. Seventeen mobile package tests,
both type checks and full root/mobile lint pass. General runs 37371940769 and
37371935667 pass Cloudflare build/browser validation, but each general validation
job fails to acquire a hosted runner before any step. Complete broader CI and the
recorded dependency findings remain open; audit thresholds are unchanged.

The owner confirmed existing contacts on preceding build 7. Neither phone upgrade
copied or reset the personal database. Build-8 visibility, exact data equality,
fresh phone/web sync, provider pilots and physical privacy/accessibility remain
unverified. [Build 7](personal-ios-build7.md) retains its separate six native
journeys and physical delivery evidence; [build 4](personal-ios-build4.md) is historical.

The preceding **build 6** added an optional device-wide
Face ID/Touch ID/passcode gate to schema 15 and the default-off Gmail cache. Both
native Release jobs and isolated SQLite/Keychain startup pass in run 37321546205.
That build-6 source passed 878 root tests, 398 D1 tests with 11 documented skips,
17 native package checks and 157 native data/sync regressions. Source, checksum,
first-launch screen and strict signature checks passed. The phone was unreachable
at that time; its later build-7 upgrade now succeeds. Preserve the package in
[the build-6 record](personal-ios-build6.md) as historical evidence and use the
current build-8 record for delivery. The earlier signed
[build 5](personal-ios-build5.md) remains separately preserved. Private database
copying remains subject to the pending explicit permission. The owner's later
instruction to use Simulator is fulfilled with two new Everclose devices. Actual
native offline contact creation, exact email/notes after restart and the default-off
lock control pass in the synthetic QA device. The clean device starts with zero
contacts. Hosted Google-login navigation and cancellation also pass, stopping
before account selection or device authorization. Existing simulators were not changed; the Mac remains locked, so UI
verification uses headless XCTest and simulator screenshots.

## Current shared-prompt development

Shared web/iPhone birthday, check-in and reminder-preference snoozes are implemented
at `059a5d7`, with durable offline choices, exact retries, reason-specific Bring
back and explicit conflict review. All 913 root tests, 15 disposable D1 journeys,
17 native package tests, types/lint/export and two actual native preview checks
pass. The inspected largest-text picker keeps Cancel and all choices reachable;
migration preserves all 21 existing synthetic data tables and private intents.
[Native Today](native-today.md#shared-web-and-iphone-prompt-choices--verified-preview)
contains exact provenance and scope. Build 9 is prepared for clean compilation;
the phone and user-ready simulator retain build 8. The new server extension is
not deployed, and no Gmail migration/queue rollout is implied. Latest general CI
37374856861 passes cloud validation but fails its unchanged dependency-audit gate.

## Delivered personal iOS implementation

- Real Google account sign-in and account-isolated synchronization with the hosted CRM; existing 12-contact workspace was verified on the preceding installed build.
- Today, People, profiles, notes, interactions, relationship/family details, plans and reminders, with durable offline changes, draft recovery, paged history and explicit conflict review.
- Hosted-photo downloads, bounded account-local cache, native system-photo selection, explicit preview/save/removal, offline photo drafts and a durable upload queue. Lost acknowledgements retry the same operation; changed cloud photos require review.
- Reviewed iPhone Contacts capture and linking, optional consented reads and source sharing; saved Google Calendar context and native agenda/association forms.
- Reviewed Apple Calendar editor actions and durable creation receipts, with separate optional read access/date following. Real physical Calendar behavior remains unverified.
- Safe startup recovery for database, Keychain identity and account-cache failures, preserving the original account cache, drafts and queued edits.

The photo API is deployed in Worker `f300697b-8aa5-46c8-b556-fc00144725d4`.
Readiness is healthy; an unauthenticated photo POST returns 401. No photo schema
migration is introduced by photos: installed build 4 remains schema 14, production remains migration 44
and local cloud development now has migration 48.

## Installed build-4 verification

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
4. Complete the real Gmail client/vault/pilot, reviewed activity and operational validation of recurring jobs. Download/matching and web/native context now have tested source implementations. LinkedIn currently supports reviewed profile URLs/export imports; continuous LinkedIn account synchronization is unavailable.
5. Complete Sign in with Apple/account management, dependency security, public provider approvals, TestFlight/App Store distribution, operational checks and the daily-use pilot.

Local development OAuth still needs its own configured credentials. Native sign-in
uses the hosted production login and does not require a localhost OAuth client.
Local Everclose simulators are now installed and verified at the owner's request.
The installed personal build and successful isolated CI/local simulators do not
complete the integrated personal beta or public release.

The saved Gmail stash `3473e7443855718e3aaee489d4ce1aa739add78e` has been restored
and extended into the current download implementation; do not apply it again to
this checkout. It remains as a historical backup. Migration 48 is applied to local
D1 only. No Gmail download/matching or migration 45–48 is deployed to production. Mobile
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
correspondence now has a source implementation: a separate read-only protocol,
schema-15 default-off offline cache and owner/session/catalog/identity fences.
All 868 root tests, 15 focused D1/mobile SQLite transport tests and eight
desktop/mobile profile/Calendar journeys pass. Root/native TypeScript and lint,
five native package tests, the production Hermes export and standalone/Cloudflare
builds pass. Both native build-5 Release jobs and isolated SQLite/Keychain startup
pass in run 37306709947. Build 5 is signed and verified; installation awaits phone
reconnection/unlock after CoreDevice error 1011. Its exact source/package evidence
is in [the build-5 record](personal-ios-build5.md). This source is not in installed build 4.
Cross-account/activity review remains engineering work. Consented recurring Gmail
jobs now have a tested default-off source implementation; actual queue provisioning,
OAuth renewal and a controlled mailbox pilot remain required.
Real clients/vault and a controlled mailbox pilot remain required.
Readiness requires migrations 45–48 before any source deploy; production was last
verified at migration 44 and local D1 has 48. Installed mobile remains schema 14;
current native development source has schema 15.

## Latest bounded follow-up

Daily/hourly Gmail refresh, cancellation fencing, checkpoint recovery, expired-history
repair, dispatch fairness and the populated 47-to-48 upgrade pass the focused tests.
All 878 root tests pass with no skips, as do the twelve download/profile browser
journeys, root TypeScript/full lint, native source checks and the Cloudflare build.
The migration metadata/schema generation agrees with migration 48. This is a
server/web change and does not replace the signed build-5 artifact. After the owner
reported the phone unlocked, another targeted install still failed with CoreDevice
1011; cached details reported no tunnel and the same 10:57 UTC last connection.
The owner has been asked to reconnect directly by USB and confirm Trust. Reuse
build 5 as soon as the phone is reachable, then verify exact bundle metadata,
launch and process stability. No physical UI/data or private database result is
claimed.

## Device lock and OAuth setup follow-up

The signed build 6 adds an optional device-wide authentication gate in
Account & sync. Twelve new controller scenarios, seventeen mobile package tests,
all 157 existing native data/sync regressions, native/root types and lint, and the
Hermes export pass. It uses the already configured Face ID/Keychain modules,
preserves account caches/drafts and has verified-device recovery for an unreadable
policy. No mobile or cloud schema migration is added. Both native Release jobs and
isolated SQLite/Keychain startup pass in run 37321546205; source/checksum and strict
signed-package checks pass. Physical installation and editor/snapshot/Face ID checks
remain required. See [native device lock](native-app-lock.md) and the
[build-6 release record](personal-ios-build6.md).

The current source at `52dbdd07ccc8bc5dcb0a22e359221b037094b874` passes 878 root
tests with no skips and 398 D1 tests with 11 documented skips in run 37321546195.
Cloud build/browser checks and lint pass; general validation then fails at the
existing dependency-audit gate. The phone connection check at delivery still has
no tunnel/developer services and the cached 10:57 UTC last connection. macOS USB
inventory did not detect an iPhone. No build-6 installation was attempted against
that unavailable connection.

The preceding Gmail scheduling source at `b996d75122adcb6fca90acda0c55663b902e99ec`
passes both native Release jobs and isolated simulator startup in run 37316101486.
Its CI run 37316101466 passes cloud validation and fails general validation at the
unchanged dependency-audit gate. Those results do not validate the later lock source.

Google Cloud's existing Everclose CRM project and production identity client were
located in the signed-in owner's browser. A separate development-project form is
prepared, but automatic approval review rejected creating that persistent external
resource because the specific project creation was not explicitly authorized.
The owner has been asked to choose between approving the new development project
and creating a localhost client in the existing Everclose project. Do not retry
creation or create the alternate client until that reply arrives. No Google project,
client, grant or credential change was made. The prepared browser tab is marked for
handoff. The Mac was reported locked. The owner is away and asked to use Simulator;
the local build-6 offline journey now passes without unlocking the Mac. Both Mac
and iPhone should be unlocked and connected by USB only for a later physical
installation check. See the build-6 record and `tests/native-ui/README.md` for the
local evidence and repeatable test scope.
