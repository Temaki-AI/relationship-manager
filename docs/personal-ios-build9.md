# Everclose personal iOS build 9 — release verification

Clean version 1.0.0/build 9 runs on the **Everclose Build 9** iPhone 17 Pro / iOS
26.2 simulator. Its original empty local-only database and installation identity
are preserved through schema 15-to-16 migration. The welcome screenshot was
inspected. The owner phone still has build 8; build 9 has not been installed.

Build 9 adds shared web/iPhone Today prompt snoozes, durable offline choices,
reason-specific Bring back and explicit review of overlapping choices. The
separate server extension is live in migration-44-compatible Worker
`370949af-afef-44e2-8578-900625e1ce0d`, from source `d741d51`.
No owner preference round trip or provider consent is claimed.

## Compiled release and checks

Source is `1d0366818d1aff0ac386305a10704ad651ef2777`; CI merge
`c0df9d70a925806725b4c5f4757cc9efd2800bcb` has an identical tree.
[Native CI 37380356652](https://github.com/Temaki-AI/relationship-manager/actions/runs/37380356652)
passes both Release compilations, linkage and actual SQLite/Keychain startup with
Xcode 26.4.1/build 17E202. Its full offline journey fails in 352.244 seconds after
a reminder restart: the helper tries to scroll while navigation is not hittable.
The screenshot shows loaded Today and visible tabs. The failed result and logs
remain preserved; this CI run is not green.

The test now waits for foreground and hittable navigation after restart, retaining
every contact/draft/plan/history/reminder assertion and a bounded failure deadline.
A fresh isolated simulator is rerunning the whole journey against the unchanged
compiled build 9. This pending result is a phone-delivery gate.

Separate tests against the unmodified compiled build 9 pass:

- Prompt persistence, Cancel and reason-specific Bring back: 42.907 seconds,
  one test, zero failures/skips.
- Largest-text choices and persistent Cancel: 32.537 seconds, one test, zero
  failures/skips. The screenshot was inspected; all choices remain reachable.
- All 23 retained synthetic data tables and installation identity are unchanged
  through these actions; no shared intents or new history remain.

Source validation passes all 913 root cases with no failures/skips, 15 disposable
Worker/D1 shared journeys, 17 mobile package tests, types, lint and Hermes export.
The limited server rollout separately passes 793 full tests, 24 selected D1
checks and three additional middleware/dispatcher journeys. Production login and
readiness remain healthy; invalid phone sessions and extra paths are rejected.
No production migration or Gmail binding was added.

## Packages and private evidence

| Package | SHA-256 |
| --- | --- |
| Device archive | `f180acebcd61b6cd8cc74c7143dcd5d089b8a0e23b12c1cd91d1182f95840862` |
| Simulator archive | `b6bd1ca0a2318d5074146a10f2c26cb9f332653d8e8facf21cf95f025c98f120` |
| Signed personal IPA | `9da4c91d11bf12367ea7adee5f6181f97cf3ab641ee6cb29937017c9f7194523` |

The IPA is `apps/mobile/build/releases/Everclose-1.0.0-ios-build9.ipa`; strict
signature verification passes with the existing local identity/profile. No key
was exported or uploaded. Private archive, migration and signing receipts are
under `apps/mobile/build/releases/build9-ci-device/` and `build9-ci-simulator/`.
Native results are `build9-ci-offline.xcresult`,
`build9-release-prompts-actions.xcresult`,
`build9-release-prompts-largest-text.xcresult` and the pending
`build9-offline-recovery.xcresult` under `apps/mobile/build/native-ui/`.

General CI 37380356500 passes cloud validation but fails the unchanged dependency
audit gate. Physical delivery, current account/provider/VoiceOver/biometric pilots,
Gmail rollout and TestFlight/public release remain in the
[development plan](product-development-plan.md). The full development goal remains
active.
