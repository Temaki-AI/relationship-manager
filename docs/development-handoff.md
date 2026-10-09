# Development handoff — 9 October 2026

Current development delivery: the web and iOS interface now share Today,
People, Calendar, and Settings, with secondary tools disclosed when requested.
Profiles separate Overview, Activity, and Details. The user-ready simulator
`AAC8EF14-F696-416B-ACBF-6706D5EF8B77` runs native build 12 with UI JavaScript
source `1ccab87d7acdb6d19d4d0a8f9ca913496245ff00`. The exact bundle passes the
offline journey and normal/largest-text navigation checks. Installation
preserves every row in all 26 current SQLite tables; schema 18, integrity,
foreign keys, and bundle receipt checks pass. Its inspected launch retains the
owner's unfinished Google connection. On 9 October, the signed iPhone UI preview
with the same verified bundle was installed in place on TIE Fighter. Fresh
metadata confirms 1.0.0/build 12; launch succeeds and the same process (4414)
is present in a subsequent device process check. No app uninstall, data reset,
or personal phone database copy was performed. This confirms installation and
process startup, not a visual or Google-sync round trip. See the
[interface audit and verification](ui-ux-audit-2026-10-08.md).

Production delivery remains the Calendar-only server rollout. The owner
approved the private production backup. Both exact Calendar migrations 49–50 are
applied, with all original rows verified unchanged across 69 production tables.
The compatible server source `d8fb137` is deployed as Worker
`ac198899-e378-48d1-b9c4-3fea9a83d436`; live readiness, unauthenticated endpoint
protection and the existing signed-in web session pass. Google data OAuth,
Gmail migrations 45–48, provider pilots and the phone/web owner round trip remain
open. No personal phone database was copied or reset. See the updated
[build-12 delivery](personal-ios-build12.md) and
[Calendar server rollout](calendar-server-rollout.md).

The new web interface and direct Calendar rescheduling UI are in the draft PR
and are not deployed to production. The records below describe preceding
preparation and builds; current delivery above supersedes their older state.

Everclose's personal web release is deployed at everclosecrm.com. Personal iOS
**build 10** is signed and installed in place over build 9 on TIE Fighter.
Fresh installed metadata reports 1.0.0/build 10. iOS blocks its launch because the
phone is locked; current launch/process stability awaits an unlocked phone.
The **Everclose Build 10** simulator runs the exact compiled release as process
13847; its welcome was inspected, and all 23 data tables and installation identity
are unchanged, with schema 16 and SQLite integrity intact. Native CI 37391200805
passes both Release builds, startup and the complete offline journey in 452.447
seconds (one pass, zero failures/skips). No personal database was copied or reset.
[The build-10 record](personal-ios-build10.md) contains exact provenance and receipts.

Build 11's shared Calendar reservations and schema-17 outbox pass both native
Release builds, startup and the full offline journey in CI 37399778847. The
downloaded result reports one pass, zero failures/skips and a 430.760-second
journey; source/artifact provenance and archive hashes pass independently.
It is compiled but not installed. See [the build-11 record](personal-ios-build11.md).

The build-12 source candidate adds explicit original-event verification for legacy
receipts, new sign-ins and recovery, preserving the original publisher/epoch and
uncertain request bodies. Schema 18 preserves every existing schema-17 data table.
All 955 root cases pass collectively (953 in the restricted run, two localhost
cases in their permitted rerun), as do 22 mobile tests, types/lint, Hermes export,
Cloudflare build and dry run. The selected D1 suite passes 39 cases; all eight
native recovery cases pass again after strengthening queued-edit preservation.
Build 12 passes both Release jobs, startup and the full offline journey in
CI 37402857771. The downloaded result independently reports one pass, no failures
or skips, in 445.068 seconds. Both matching artifacts pass source/archive/linkage
checks; the iPhone package is signed and its unchanged bundle and final strict
signature pass. The isolated local-only QA simulator upgrades schema 16-to-18,
retaining all 23 original data tables, four guarded contacts and installation
metadata except the schema marker. Its inspected Today screen runs as process
32585 before the QA simulator is shut down; the phone/user-ready simulator retain
build 10. The Calendar-only server candidate is saved as local
commit `d8fb137` on the deployed baseline, with 814 cases collectively passing and
31 Calendar plus three Today cases passing on real D1. A production export was
rejected by automatic approval review; the explicit private-backup permission
request is pending. No migration, deployment or personal installation occurred.
The full Worker readiness fix separately requires both Gmail migration 48 and
Calendar migration 50; its two readiness tests using real disposable D1 pass.
Follow-up types, Cloudflare compilation and dry run also pass. Native source is
unchanged from the verified artifact; these cloud-only fixes and release records
need no additional native compilation.
See [Calendar coordination](calendar-publication-coordination.md) and
[the build-12 candidate](personal-ios-build12.md). Production migration 44 and the
installed build 10 are unchanged. Real Calendar effects, cross Google/EventKit
identity and arbitrary selected Apple event context still require completion.

Direct plan and reminder rescheduling is implemented for desktop/mobile web in
month details and agenda. Date-only reviews preserve private notes and history,
reject concurrent edits or a changed recovery epoch, and confirm an unchanged
lost-reply retry without another journal write. Five real D1 cases and four
desktop/mobile browser cases pass, including the existing capture/completion
journey. Types, full lint, Cloudflare build and Worker dry run pass. These changes
are local and do not change the compiled native build or production. See
[Calendar rescheduling](calendar-rescheduling.md).

A scoped root CSS-parser patch removes the two moderate audit findings, leaving
seven high and zero moderate. Tailwind and native package versions are unchanged;
only postcss-selector-parser changes to 7.1.6. The app stylesheet from source `4151d70` remains
byte-identical to the original parser, as do interactive/nested selector fixtures.
Both new compatibility/security cases, types, full lint, Cloudflare build and
Worker dry run pass. This does not deploy production or change native build 12.
The redundant native run 37407591330 is confirmed cancelled with native paths
identical to the successful build-12 source. See
[dependency security](dependency-security.md) for the patch and remaining gate.

The redundant doc-only-head native run 37395171458 was cancelled after confirming
its native source matched the delivered build-10 source. Existing build-10 native
CI remains successful. General CI 37395172147 on `efd3df3` passes 919 root tests
and 398 D1 tests with 11 documented skips; cloud validation succeeds and the
unchanged dependency audit still fails. These results describe the preceding
head, not the new build-11 candidate.

The preceding **build 9** was installed over build 8 and running on TIE Fighter
(1.0.0/build 9, process 15655). Installation, fresh metadata, launch and subsequent process
stability pass. The **Everclose Build 9** simulator runs the unmodified compiled
release at welcome, with its original empty cache and installation identity
preserved through schema 15-to-16 migration. All 23 current data tables remain
unchanged after updating to the final CI artifact; its welcome was inspected.
The separate synthetic QA simulator retains its four guarded people and is
shut down after final-artifact prompt persistence/Bring back and largest-text
checks pass in 65.949 and 36.574 seconds, each with zero failures/skips. Its inspected
picker keeps all choices and Cancel reachable. All 23 synthetic data tables and
installation identity are unchanged, and SQLite integrity passes.
[The build-9 record](personal-ios-build9.md) preserves source, checksums and receipts.

Final build-9 native CI 37385220932 passes both binaries, real SQLite/Keychain
startup and the complete offline journey in 331.439 seconds, with one test and
zero failures/skips. Delivered source `c9cbca3` and CI merge `ab976b4` have identical
trees. The earlier failed CI and unsuccessful local diagnostic runs are preserved.

Build-10 source removes the image/URI decoder findings with
scoped upstream upgrades and minimal reproducible Metro/query-string adapters.
Clean installation, 22 mobile tests, types/lint, Hermes export and seven existing
foundation/supply-chain checks pass. Native compilation/startup/offline validation
also passes. The root/mobile audits still fail for braces and node-forge; the
installed phone now has build 10, with its launch blocked by device lock. See
[dependency security](dependency-security.md) for graph counts and exact scope.

Native Today has a per-person queue, combined reasons/latest history and explicit
Reach out/Log/Done/Snooze actions. Choice pickers scroll with persistent Cancel and
close when backgrounded or locked. Standard Apple method labels display clearly
while stored/raw/custom values are preserved. Native CI 37371940722 passes both
Release binaries, linkage/startup and the complete offline journey (329.156 seconds,
one test, zero failures/skips). Actual compiled build-8 background/largest-text
checks also pass; the picker screenshot was inspected. All 21 QA data tables are
unchanged, with only the existing installation marker's refresh timestamp updated.
Earlier action/restart preview evidence remains distinct in [Native Today](native-today.md).

Build-8 source verifies all 898 root cases collectively: 896 in the restricted full run and
two loopback-server cases in their permitted rerun. Seventeen mobile package tests,
both type checks and full root/mobile lint pass. General runs 37371940769 and
37371935667 pass Cloudflare build/browser validation, but each general validation
job fails to acquire a hosted runner before any step. Complete broader CI and the
recorded dependency findings remain open; audit thresholds are unchanged.

The owner confirmed existing contacts on preceding build 7. These phone upgrades
did not copy or reset the personal database. Build-9 visibility, exact data equality,
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
current build-9 record for delivery. The earlier signed
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
contains exact provenance and scope. Final clean build 9 runs on the phone and
user-ready simulator. The new extension is deployed
as Worker `370949af-afef-44e2-8578-900625e1ce0d`, from the limited migration-44
source `d741d51`, with full server tests/build and healthy live checks. No Gmail
migration/queue rollout is implied. Build-9 device compilation, source comparison
and strict package signing pass, as do simulator compilation/linkage and real
SQLite/Keychain startup. Original CI 37380356652's full offline journey fails after
a reminder restart; that failure and unsuccessful local diagnostics remain
preserved. The bounded navigation-readiness fix passes the complete native CI
37385220932 journey, and that exact compiled candidate is installed on the phone.
Final-artifact prompt/largest-text checks pass in 65.949 and 36.574 seconds,
with all 23 synthetic data tables unchanged. Earlier-candidate timings remain
separately recorded. [The build-9 record](personal-ios-build9.md) has exact
provenance. The exact native middleware allowance is corrected and passes
29 focused checks plus the actual D1 middleware/dispatcher journey. Latest general
CI 37385220851 passes cloud validation but fails its unchanged dependency-audit gate.

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
dependencies are present; the signed phone binary is the separately verified
build-9 candidate `c9cbca3`.

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

### Local Google setup isolation — 6 October 2026

Cloud development now reads all five Google client purposes, project metadata,
the connector keyring and session secret only from its ignored local configuration;
missing values cannot inherit another environment's credentials from the shell.
The template includes Gmail keys. `npm run setup:google` imports a downloaded Web
client JSON without printing secrets, preserves existing session/vault settings,
requires exact localhost callbacks/origins, distinct client IDs and separate login
and data projects, and writes the local file atomically with owner-only permissions.
All 919 root tests pass with zero failures/skips, including nine development/import
checks. Full root lint and TypeScript also pass. These tests use disposable synthetic
credentials; no real OAuth authorization or provider operation is claimed.

The [current Google setup request](google-setup-request.md) supersedes the earlier
single-project choice with three unbilled projects and nine distinct clients.
Explicit creation approval is pending after the earlier automatic review rejection.
The Mac remains locked and the existing console tab's read attempt timed out.
No real credential import, Google configuration change, production migration or
deployment was performed by this setup change.
