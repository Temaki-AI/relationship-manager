# Everclose personal iOS build 9 — delivered 6 October 2026

Version 1.0.0/build 9 upgrades the owner's **TIE Fighter** iPhone 13 in place
from build 8 and runs as process 15655. Installation, fresh installed metadata,
launch and a later process query verify delivery. The personal database was not
copied or reset. The owner confirmed contact visibility on build 7; current
phone field equality, visibility and a new phone/web preference round trip have
not been independently verified.

The **Everclose Build 9** iPhone 17 Pro / iOS 26.2 simulator runs the same final
compiled source as process 97115. Its welcome screenshot was inspected. Its
original empty cache and installation identity are preserved, with all 23 current
data tables unchanged and SQLite integrity intact. The preceding candidate
already verified the populated schema 15-to-16 upgrade without changing any of
its 21 pre-existing data tables. Synthetic fixtures remain on a separate simulator.

## Changes and compiled release

Build 9 adds shared web/iPhone Today snoozes, durable offline choices,
reason-specific Bring back and explicit review of overlapping choices. The
separate server extension is live in migration-44-compatible Worker
`370949af-afef-44e2-8578-900625e1ce0d`, from source `d741d51`.
No owner preference round trip or new provider grant is claimed.

Delivered source: `c9cbca3ee9b1962b8ac113ea2ae7476b978aa33d`.
CI merge: `ab976b438b72b62f8747d1337600e82045c53896`.
GitHub comparison verifies identical source trees. Xcode is 26.4.1/build 17E202.

[Native CI 37385220932](https://github.com/Temaki-AI/relationship-manager/actions/runs/37385220932)
passes both Release builds, linkage and real SQLite/Keychain startup. Its complete
contact, exact email/notes, draft, plan/history, reminder snooze/completion and
restart journey passes in **331.439 seconds**: one test, zero failures/skips. The
downloaded result independently reports the same pass/failure/skip counts. The
harness waits for foreground and interactive navigation after restart.

The final compiled artifact also passes two local checks on the retained
synthetic-only QA simulator: prompt persistence, Cancel, restart and reason-specific
Bring back in **65.949 seconds**, and largest-text choices in **36.574 seconds**.
Each reports one test, zero failures and zero skips. The inspected picker screenshot
shows all three choices and persistent Cancel, reachable and at least 44 points
tall. All 23 data tables and the installation identity remain unchanged, with
SQLite integrity intact, no new history and no shared intents. Normal text size
is restored and the QA simulator is shut down. These are separate from the passing
full CI journey.
The earlier unmodified candidate at `1d03668` passes prompt persistence/Bring back
in 42.907 seconds and largest-text choices in 32.537 seconds, with its screenshots
inspected and all 23 synthetic tables preserved. Those timings do not describe the
final `c9cbca3` artifact.

Source validation passes all 913 root cases with no failures/skips, 15 disposable
Worker/D1 shared journeys, 17 mobile package tests, types, lint and Hermes export.
The exact middleware allowance additionally passes 29 focused checks. The limited
server rollout passes 793 full tests, 24 selected D1 checks and three additional
middleware/dispatcher journeys. Production login and readiness remain healthy;
invalid phone sessions and extra paths are rejected. No production migration or
Gmail binding was added.

## Packages and private evidence

| Delivered package | SHA-256 |
| --- | --- |
| Device archive | `d8ddaf91cfd4bdeb06c0e3d1a4e91afc93df58fdf531d63a0b6dc0d3884d461b` |
| Simulator archive | `92489dec4b4a069e4cf99e05affe8108f8795b0a4a1cee8e5dc8a273d90781f4` |
| Signed personal IPA | `ffbe4eeaf0967a6510a041a3847ece273280cab39e344e998ad4d83018e61146` |

The IPA is `apps/mobile/build/releases/Everclose-1.0.0-ios-build9-c9cbca3.ipa`.
Strict signature verification passes with the existing local identity/profile;
four registered devices are eligible, and the profile expires 25 July 2027. No
key was exported or uploaded. Signing preserves the compiled JavaScript.

Private receipts are under `apps/mobile/build/releases/build9-ci-c9-device/`,
`build9-ci-c9-simulator/` and `build9-c9-phone-install/`. The passing result is
`apps/mobile/build/native-ui/build9-c9-ci-offline.xcresult`; the complete log is
`/private/tmp/everclose-build9-c9-green-native-ci.log`.
The final local results are `build9-c9-release-prompts-scroll.xcresult` and
`build9-c9-release-prompts-largest-text.xcresult` under `apps/mobile/build/native-ui/`.
The cache comparisons and compact local verification are retained in
`build9-ci-c9-simulator/local-release-verification.json` and the adjacent snapshots.

## Preserved earlier failures and remaining checks

Original candidate `1d0366818d1aff0ac386305a10704ad651ef2777` in native run
37380356652 compiles and passes startup but fails its offline journey in 352.244
seconds after a reminder restart. That run remains failed. Its original signed
IPA (`9da4c91d11bf12367ea7adee5f6181f97cf3ab641ee6cb29937017c9f7194523`)
was not installed on the phone; archives and receipts remain in the original
`build9-ci-device/` and `build9-ci-simulator/` directories.

Three local diagnostic journeys against that original artifact fail in 198.565,
64.461 and 149.800 seconds: a stale keyboard scroll index, lack of Notes keyboard
focus, and a People tap that leaves Today selected. The last synthetic database
retains the exact contact name/email/notes and passes integrity. None is reported
as a passing journey. Unmerged diagnostic harness changes are preserved privately
as `build9-ci-c9-simulator/local-diagnostic-harness.patch`; delivered release
validation uses the CI-verified harness. The disposable recovery simulator is
shut down with its one synthetic contact retained. No owner cache was reset.

The first final-source prompt check fails in 48.521 seconds because the second
picker does not open; the saved synthetic birthday choice is preserved. The
prompt helper now waits for enabled as well as hittable controls and resumes only
its own interrupted choice. Its next attempt fails in 45.948 seconds because the
one-direction helper scrolls down the page while the restored birthday control
is above the viewport. The helper now scrolls in the direction of the target.
The corrected full prompt and largest-text reruns pass with the final compiled
artifact, as recorded above. Both failed screenshots and result bundles remain
preserved; neither failure is reported as a pass.

The delivery closeout changes only documentation and the tested Swift prompt
harness. The app/domain sources are unchanged from compiled candidate `c9cbca3`;
the installed package remains that exact CI-verified artifact.

General CI 37385220851 passes cloud validation but fails the unchanged dependency
audit gate. Current account/provider/VoiceOver/biometric pilots, Gmail rollout and
TestFlight/public release remain in the [development plan](product-development-plan.md).
The broader development goal remains active.
