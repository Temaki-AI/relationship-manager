# Native Today — 5 October 2026

Today is now delivered in the clean compiled **build 8**, installed and running on
the owner phone and user-ready simulator. [The build-8 record](personal-ios-build8.md)
contains the green native CI, actual-release accessibility checks and installation
receipts. The earlier JavaScript-preview evidence below remains separate.

Today now offers up to eight people, with one card per person and explicit reminder,
birthday and check-in reasons. It includes the most recent recorded interaction.
It reads relevant people directly from SQLite, including people beyond the first
500 directory entries. Multiple reminders for one person cannot fill the queue.
Completed/deleted reminders and deleted people/history are excluded.

Birthdays use the same civil-date helpers as web, including year rollover and
March 1 observance of February 29 in non-leap years. A synced birthday lead-time
preference is read from the authoritative contact cache; the default is seven
days. Check-ins compare civil days, and a recent interaction instant prevents an
immediate prompt around UTC midnight. Loading failures have a retry control;
returning to the foreground and the passage of time refresh the list.

Reach out offers saved, labelled contact methods. It rechecks the selected method
before opening another app. Opening a contact method does not write history.
Log explicitly records a message, call, meetup or email using the existing atomic
interaction/outbox operation. Done completes an actual reminder; Snooze moves
that reminder to tomorrow, three days or next week at 9 AM. Both screens use the
same reminder action implementation, preserving stale-date/account guards and
the distinction between a durable CRM save and unconfirmed native delivery.
A separate birthday/check-in reason stays visible after a reminder is completed
or moved. The shared birthday/check-in preference implementation below is verified in a separate preview and awaits clean-build delivery and server rollout.

Choice lists scroll with a persistent Cancel control. At the largest accessibility
text size, the earlier UIAlert put Cancel below the visible area and XCTest
entered a repeated interruption loop. The replacement picker passes the same
interaction with Cancel visible and hittable. Choices also close when the journal
is backgrounded or locked, invalidating pending callbacks from that presentation.
Physical VoiceOver, enabled biometric-lock and current-account provider/sync
journeys remain separate release checks.

## Verification and provenance

Final tested JavaScript source: `6b3e3752ab9bc30fc4fe6bae55902ca5a142e0dd`.
Native binary source: `e0965517348e6e979cea5ec2d54be541c7355bd9`.
Hermes bundle SHA-256:
`de9ae9e83b725fc1a5a7576bce64cecc813a860f375deb61d9cba3cb6d2e6c3f`.
This is a guarded, ad-hoc-signed **JavaScript preview over compiled build 7**,
not an unmodified clean build of the new source. The subsequent clean build 8
passes native CI and is installed on the phone and user-ready simulator.

- Thirty focused Today/reminder/notification/date/intelligence/snooze regressions
  pass with zero failures/skips. Seventeen mobile package tests, both TypeScript
  checks and full root/mobile lint pass. The expanded full restricted root run
  passes 896 of 898 cases; two Cloudflare readiness cases could not bind their
  loopback test server (`EPERM`). Both pass in the separate permitted rerun
  (`everclose-native-today-cloud-health-rerun.log`), with no source changes or skips.
  Together these runs verify all 898 root cases; the original restricted failures
  remain recorded.
- Three native read-only tests at `accessibility-extra-extra-extra-large` pass in
  106.133 seconds: background closure, cancellation without history and reachable
  controls at least 44 points tall.
- The final native Snooze/Done/explicit-Log journey passes in 36.798 seconds through
  restarts. Only explicit Log creates the one confirmed conversation and its
  durable sync intent; the moved reminder stays future/open, and the other is
  completed. Independent birthday/check-in reasons behave correctly.
- A separate 32.548-second visual check passes and preserves the inspected picker
  screenshot with its persistent Cancel control.
- Read-only SQLite checks verify integrity and preservation of every prior
  synthetic contact, source, review, policy and outbox row. These tests used a
  separate named fixture on the local-only QA simulator, with no owner account,
  provider read, production write or personal database copy.

Private evidence stays ignored under `apps/mobile/build/native-ui/` and
`apps/mobile/build/releases/build7-today-accessibility-preview/`: the
`build7-today-accessibility-readonly`, `-actions` and `-picker-visual` result
bundles/attachments and `cancel-cache-verification.json` / `actions-cache-verification.json`.
Earlier failed preparation/interrupted large-text results are preserved in
verified ZIP archives; the interrupted log is preserved losslessly as gzip.
The first Today preview's passing results remain distinct from this final picker.

The QA simulator's text size is restored and it is shut down. The user-ready
build-8 simulator runs at welcome, and the phone runs build 8 after an in-place
upgrade. The owner's contact-visibility confirmation applies to preceding build 7;
current-build visibility and a fresh phone/web sync round trip remain unverified.

Native CI [37363883290](https://github.com/Temaki-AI/relationship-manager/actions/runs/37363883290)
passes both Release binaries and the complete 378.128-second offline journey for
the contact-label source. Later Today CI
[37367898696](https://github.com/Temaki-AI/relationship-manager/actions/runs/37367898696)
compiles the device binary; its simulator job is cancelled without steps because
GitHub reports that a hosted runner could not be acquired after multiple attempts.
That is not a passed simulator build. Its replacement
[37371940722](https://github.com/Temaki-AI/relationship-manager/actions/runs/37371940722)
passes both clean build-8 Release binaries and the complete 329.156-second offline
journey. Two local checks against the actual compiled build 8 pass background
closure and largest-text cancellation; all 21 data tables are unchanged, with only
the existing installation marker's refresh timestamp updated. Both broader CI jobs in
run 37367992123 likewise failed to acquire hosted runners; no test failure or
audit result can be inferred from that cancellation.

The broader product plan remains active: real OAuth/staging and provider pilots,
shared prompt preferences, shorter profiles/calendar editing, the personal-use
pilot, physical privacy/accessibility checks, dependency remediation and public
release gates remain documented in the product plan and implementation roadmap.


## Shared web and iPhone prompt choices — verified preview

Source `059a5d7f4ee063e2db53153dad6c44d4433a9066` adds separate birthday and
check-in snoozes to native Today, with Tomorrow, In a week, In 30 days and Bring
back. Snoozing a reason leaves other reasons and reminders available and creates
no interaction. The expanded Snoozed prompts list includes pending choices and
held choices requiring explicit web/iPhone review.

`GET/POST /api/v1/today-snoozes` maps existing web `daily_snoozes` to stable public
person/reminder UUIDs. This extension uses existing mutation receipts, owner
membership, active device authorization, recovery epochs and atomic D1 guards.
It adds no cloud migration and leaves the version-4 CRM contract unchanged. A
lost reply retries the original operation byte for byte without reapplying it
over later web choices. Concurrent web choices hold the iPhone intent for a fresh
explicit review. New choices after travel use the current civil day/time zone.

Native schema 16 adds a bounded preference cache and durable intent queue. Local
choices save atomically before syncing; a new person's choice waits for its core
CRM acknowledgement. Frozen requests remain unchanged through uncertainty,
restart and later local edits. Restore holds earlier-epoch choices, and invalid
or incomplete downloads cannot replace the cache. Local-only use creates no
shared preference outbox. The existing reminder-date Snooze action remains a
separate reminder edit; a web reminder-preference snooze hides only that due task
and reveals the next due task without moving either reminder.

Verification completed:

- All **913 root tests pass**, with zero failures/skips, in the permitted final
  full run. The preceding run's seven migration-fixture failures remain recorded;
  those simulated older schemas still contained the two new tables. Corrected
  fixture setup, its 48 focused checks and the final full run pass.
- All **15 shared journeys pass against disposable Worker/D1**, including lost
  replies, conflicting choices, invalid acknowledgements/downloads, account
  changes, restore, revocation during a write, the 500-active-choice boundary,
  pre-publication people, travel and reminder ordering.
- Seventeen native package tests, root/mobile TypeScript and lint, and the iOS
  Hermes export pass.
- Actual native preview actions pass in **40.827 seconds**, including Cancel,
  save, restart and reason-specific Bring back. Largest-text picker controls pass
  in **27.397 seconds**; the screenshot was inspected with all three choices and
  persistent Cancel visible and reachable, each at least 44 points tall.
- The retained synthetic cache migrated from 15 to 16 with SQLite integrity
  intact and all **21 existing data tables unchanged**. Only schema-version
  metadata and the installation refresh timestamp changed. Two local-only
  choices were saved and brought back, with zero shared intents or new history.
  One explicitly guarded synthetic birthday was moved to the next day before
  the baseline so checks remained valid across local midnight; every other row
  was checked unchanged. No owner/provider data was accessed.

This is a guarded JavaScript preview over compiled build 8, **not a clean build
9**. Native source is `3d39dcd1334874544bc4e41505ab4717745ab9ac`; JavaScript source
is `059a5d7f4ee063e2db53153dad6c44d4433a9066`; bundle SHA-256 is
`98c7eafff37ff7e9dcf8e67ecced94b7a9cf2f177b8feb47cb2434c46eaeed82`.
Private receipts remain in `apps/mobile/build/releases/build8-shared-prompt-preview/`
and the `build8-shared-prompts-actions` / `build8-shared-prompts-largest-text`
result bundles under `apps/mobile/build/native-ui/`. The QA simulator retains
schema 16, normal text size and its four synthetic people, and is shut down.

Final clean build 9 runs on the phone and user-ready simulator. The shared server
endpoint is deployed in Worker `370949af-afef-44e2-8578-900625e1ce0d`, from isolated
source `d741d51` over the production-compatible `039c12b` baseline.
Production remains migration 44, while this branch contains separate undeployed
Gmail migrations 45–48; deploying the entire branch would change unrelated
readiness/queue requirements. The limited candidate passes 793 full root tests, 24 selected D1 checks, three additional D1 HTTP/authorization journeys, lint, the complete Cloudflare build and the deployment dry run. Live readiness/login remain healthy; an invented phone token reaches the exact route and is rejected as an invalid session, while extra paths remain closed. No migration or Gmail binding was added, and no owner preference round trip is claimed.

Latest completed general CI `37385220851` passes cloud validation but fails at the existing
`npm audit --audit-level=moderate` gate. This is an actual audit failure, distinct
from earlier unavailable-runner cancellations. No audit threshold was weakened;
public release remains gated by dependency remediation and the account/physical
pilots already recorded in the product plan.


Server preflight caught a missing exact-path native middleware allowance after
handler-only checks had passed. The shared devices policy and its Google-mode
middleware test now include only `/api/v1/today-snoozes`, with extra paths rejected.
All 29 focused checks pass; the isolated server's complete actual middleware to
dispatcher journey also passes against D1, including immediate device revocation.
The fix is included in the deployed `d741d51` source. It does not alter the
already compiling iPhone client.

Clean build-9 device CI in run `37380356652` passes compilation and linkage with
Xcode 26.4.1. Its CI merge `c0df9d70a925806725b4c5f4757cc9efd2800bcb` has no file
differences from candidate `1d0366818d1aff0ac386305a10704ad651ef2777`. The signed
IPA passes strict verification and stays private; SHA-256 is
`9da4c91d11bf12367ea7adee5f6181f97cf3ab641ee6cb29937017c9f7194523`.
Simulator compilation, linkage and real SQLite/Keychain startup also pass in
that run. The full offline journey fails after saving a reminder and restarting:
navigation exists in the final screenshot/hierarchy, but the helper attempts to
scroll before controls are hittable and reports no foreground scroll view.
The original failed log and result bundle are preserved. The test now waits for
foreground, interactive navigation after restart, with a bounded failure deadline
and every persistence assertion retained. Original CI 37380356652 remains failed;
unsuccessful local diagnostics are separately recorded. Final CI 37385220932
passes both binaries, real startup and the complete offline journey in 331.439
seconds, with one test and zero failures/skips. That final candidate `c9cbca3`
(identical CI merge `ab976b4`) upgrades the phone in place from build 8 to 9;
installed metadata, launch and later process stability are verified. The final
signed IPA SHA-256 is
`ffbe4eeaf0967a6510a041a3847ece273280cab39e344e998ad4d83018e61146`.

That final `c9cbca3` artifact also passes local prompt persistence, Cancel, restart
and reason-specific Bring back in **65.949 seconds**, and the largest-text picker
in **36.574 seconds**. Each reports one test, zero failures and zero skips. The
inspected screenshot shows Tomorrow, In a week, In 30 days and persistent Cancel,
all reachable and at least 44 points tall. All 23 synthetic data tables and the
installation identity remain unchanged, SQLite integrity passes, and no history
or shared intents are added. The two preceding failed prompt runs remain preserved;
the corrected harness waits for enabled controls, scrolls toward a target above
or below the viewport and resumes only its own interrupted birthday choice.
Normal text size is restored and the synthetic QA simulator is shut down.

The earlier unmodified candidate at `1d03668` separately passes prompt persistence/Bring
back in 42.907 seconds and largest-text reachability in 32.537 seconds, with zero
failures/skips. The picker screenshot was inspected. All 23 existing synthetic
data tables and installation identity remain unchanged. The user-ready simulator
runs clean build 9 with its original empty database preserved through 15-to-16
migration; its welcome screenshot was inspected. See [the build-9 record](personal-ios-build9.md).

Private server receipts and exact deployment logs are under
`apps/mobile/build/releases/shared-prompt-server/`. The limited source is
published on `codex/shared-prompt-server`; its managed worktree is archived and
recoverable after the compiled output and deployment receipts were preserved. Main development remains on
`codex/personal-working-release`, including the separate undeployed Gmail work.
