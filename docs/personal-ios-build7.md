# Everclose personal iOS build 7 — simulator release

Build 7 (version 1.0.0) is installed and running in the local **Everclose Build 7**
iPhone 17 Pro / iOS 26.2 simulator. The actual compiled Release app passes the
native offline journey, hosted Google-login navigation, first-use notification
permission, visible reminder delivery while the app is closed, and actual iOS
Contacts create/attach/unlink and permission-denial flows. The user-ready
simulator has zero contacts and opens the Google welcome screen; the synthetic QA
fixture stays on a separate, now shut-down simulator.

Compiled application source: `e0965517348e6e979cea5ec2d54be541c7355bd9`.
Native CI run: [37340714930](https://github.com/Temaki-AI/relationship-manager/actions/runs/37340714930).
Artifact merge commit: `d43fe34fa642a33c4658d68e127322540dd768bc`.
The corrected harness/documentation commit `e1d9e92` does not change this
application source. A later contact-label display fix is described separately
below; its source checks do not establish delivery in this downloaded artifact.

## Reminder behavior

Build 7 adds native Snooze choices for Tomorrow, In 3 days and Next week at 9 AM in
the iPhone's current timezone. The new time is stored atomically with its offline
sync intent before replacing the iOS alert. It preserves the person, reminder
identity, private notes and confirmed history. It does not record an interaction
or reopen a completed reminder.

Original sync bases and frozen requests preserve concurrent web changes. Overlapping
date changes need explicit review; editing an already held reminder keeps its
conflict status. Repeating the same instant is a no-op. Invalid, stale, completed
or removed local records do not enqueue another time. A lost outbox write rolls
back the reminder and retains its original scheduling receipt.

The UI distinguishes a saved CRM change from an unconfirmed iOS alert replacement.
Completion is committed before cancelling the old native alert. Both reminder action targets
are at least 44 points tall. Leaving the screen suppresses late action alerts.
The reminder's person link and its Snooze/Complete buttons are separate native
accessibility controls. The person link announces the title and due time; each
action includes the reminder title so multiple reminders for one person are
distinguishable. The previous enclosing button hid this information and its
nested actions from VoiceOver and XCTest.

The actual build-6 simulator exposed a first-use notification race: allowing iOS
permission while the automatic reminder refresh ran saved the reminder but left
its alert unconfirmed until restart. Build 7 now retries a refresh only after
checking the exact persisted future time, original person and active reminder.
An account switch, including switching away and back, invalidates the request;
completion or removal cancels any late receipt. The retry is bounded and does not
weaken the existing scheduler generation fence. The actual build-7 first-save test
passes with normal iOS permission, no warning and a persisted native scheduling
receipt before any restart. A separate test confirms visible OS delivery with the
app not running.

Version remains 1.0.0, native schema remains 15 and the frozen version-4 sync
contract remains unchanged. No native dependency, Google grant, cloud schema or
production deployment is introduced. Both build-7 native Release binaries compile;
the simulator artifact is installed and the device artifact is locally signed with
a verified signature. Build 7 has not been installed on the physical phone.

## Verification status

Source validation passes 892/892 root regressions with zero failures/skips,
17 native package tests, TypeScript/lint and Hermes export. Five focused SQLite
reminder checks and three phone/cloud conflict/retry/completion journeys pass;
the cloud journeys also pass against disposable Workerd/D1. Six new notification
regressions exercise guarded refresh retries, account changes and late receipts.

The [native UI harness](../tests/native-ui/README.md) passes these six independent
tests against the unmodified downloaded build-7 artifact. Each has one passing
test, zero failures and zero skips:

| Native journey | Duration | Private result bundle under `apps/mobile/build/native-ui/` |
| --- | ---: | --- |
| Four tabs, exact contact data, restart, edited draft recovery, plan/history, reminder denial/snooze/completion, lock off | 242.731 s | `build7-release-offline-journal-attempt3.xcresult` |
| First notification permission and immediate saved receipt | 38.659 s | `build7-release-first-notification.xcresult` |
| Visible OS reminder with Everclose not running | 46.189 s | `build7-release-closed-notification-attempt2.xcresult` |
| Hosted Google page and cancellation back to welcome | 10.806 s | `build7-release-hosted-sign-in.xcresult` |
| Actual Contacts picker, reviewed attach/create, restart and confirmed unlink | 110.685 s | `build7-release-contacts-attempt4.xcresult` |
| Revoked Contacts access preserves saved data and verifies unchanged native source fixtures | 21.518 s | `build7-release-contacts-denied.xcresult` |

The Contacts test uses only two synthetic records on the separate QA simulator.
Everclose obtains permission through the normal iOS 26 **Share All 8 Contacts**
screen and chooses each record in the real system picker. Reviewed fields preserve
the existing preferred email and private notes; a deliberately unselected phone
is excluded, only two reviewed CRM people exist, and source details remain private
with no source upload. Confirmed unlink survives restart and retains accepted
methods. The native framework verifies both original address-book fixtures remain
unchanged. A read-only SQLite digest is identical before and after permission
denial across contact/source/policy/preview and sync-queue tables. Limited Contacts
access and physical-device behavior remain unverified.

Inspection of the actual Contacts screenshot exposed the standard Apple label
`_$!<Work>!$_` on the profile. The follow-up source fix displays recognized standard
labels as readable English in native profile/review/policy/editor and web profile/
editor/source views. It preserves raw stored/source labels and custom labels,
including when an unrelated method is edited. Source regression checks and a new
native display test track this separately from the six release results above.

The closed-app notification screenshot was inspected. The empty user-ready cache
also passes read-only schema-15 and SQLite integrity checks, and the launched
Everclose process remains running. Native tests run serially: an earlier concurrent
notification run was interrupted by host memory/disk pressure and is not counted
as a pass.

CI run 37340714930 is **not green**: its native offline gate failed because the
old XCTest Command-A input replacement did not select the native date field.
The corrected harness uses the native Select All menu, keeps inputs above the
keyboard, verifies exact text and accepts the empty field's placeholder. That
harness passes locally against the same compiled artifact. The corrected native
CI run [37353387558](https://github.com/Temaki-AI/relationship-manager/actions/runs/37353387558)
now succeeds for source `e1d9e92`: both Release jobs, linkage/startup and the entire
offline journey pass. Its native UI test takes 371.766 seconds with zero failures
or skips. The workflow allows 600 seconds without skipping assertions. The
installed artifact's application source is unchanged by that harness/documentation
commit. General CI [37353387544](https://github.com/Temaki-AI/relationship-manager/actions/runs/37353387544)
passes 892 root cases and the separate Cloudflare build/browser job, but its
validation job is cancelled at the 25-minute limit while healthy D1 cases are
still advancing. Its complete D1 suite and later gates did not finish. The updated
validation allowance is 60 minutes; assertions, skips and audit thresholds are
unchanged. The complete rerun and the earlier dependency-audit issue remain open,
separately documented in [dependency-security.md](dependency-security.md).

## Packages and next checks

The verified simulator archive SHA-256 is
`e92fc4432019cd845cc469bb7147dce50c61ac1a6d078a812ca1a4e38ee629c7`.
The locally signed device package is
`apps/mobile/build/releases/Everclose-1.0.0-ios-build7.ipa`, SHA-256
`da109d8a2abb8a41130bc2874e5749f31ad70440bdf705b063cebbff244a22ff`.
Strict signature verification passes; no signing key was exported or uploaded.

Private compiled artifacts, screenshots, result bundles and signing receipts stay
under the ignored mobile build directory. When back at the Mac, select the
**Everclose Build 7** simulator and continue with Google using the existing
Everclose account. The live test cancels before account selection and device
authorization; authenticated account sync and provider consent are still unverified.
Physical Contacts/Calendar/biometrics/VoiceOver checks, the real-account integration
pilot, production migration rollout and TestFlight/public release remain open.
This closes the simulator delivery; it does not complete the wider development plan.
