# Native Today — 5 October 2026

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
or moved. Native birthday/check-in prompt snoozes shared with web remain open.

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
not an unmodified clean build of the new source. Build 8 is now configured for
the next clean native CI compilation. It has not been installed on the phone.

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
build-7 simulator remains running at welcome, and the phone keeps its previously
verified build 7 with owner-confirmed existing contact visibility.

Native CI [37363883290](https://github.com/Temaki-AI/relationship-manager/actions/runs/37363883290)
passes both Release binaries and the complete 378.128-second offline journey for
the contact-label source. Later Today CI
[37367898696](https://github.com/Temaki-AI/relationship-manager/actions/runs/37367898696)
compiles the device binary; its simulator job is cancelled without steps because
GitHub reports that a hosted runner could not be acquired after multiple attempts.
That is not a passed simulator build. The next build must verify the final picker
source and updated offline harness before delivery. Both broader CI jobs in
run 37367992123 likewise failed to acquire hosted runners; no test failure or
audit result can be inferred from that cancellation.

The broader product plan remains active: real OAuth/staging and provider pilots,
shared prompt preferences, shorter profiles/calendar editing, the personal-use
pilot, physical privacy/accessibility checks, dependency remediation and public
release gates remain documented in the product plan and implementation roadmap.
