# Everclose personal iOS build 7 — reminder actions

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
Completing a reminder now reports an alert-cancellation failure truthfully rather
than saying the durable completion was unchanged. Both reminder action targets
are at least 44 points tall. Leaving the screen suppresses late action alerts.

The actual build-6 simulator exposed a first-use notification race: allowing iOS
permission while the automatic reminder refresh ran saved the reminder but left
its alert unconfirmed until restart. Build 7 now retries a refresh only after
checking the exact persisted future time, original person and active reminder.
An account switch, including switching away and back, invalidates the request;
completion or removal cancels any late receipt. The retry is bounded and does not
weaken the existing scheduler generation fence. Native delivery verification of
this correction is pending.

Version remains 1.0.0, native schema remains 15 and the frozen version-4 sync
contract remains unchanged. No native dependency, Google grant, cloud schema or
production deployment is introduced. Build 6 remains the last locally installed
and signed package until the new native binary is verified.

## Verification status

Four focused SQLite persistence/rollback/identity checks and three complete
phone/cloud conflict/retry/completion journeys pass. The same three cloud journeys
also pass against disposable Workerd/D1. Native validation passes its package
tests, TypeScript/lint and Hermes export; root TypeScript and the expanded standalone
XCTest host compile pass. Full regression and native Release verification are in
progress. These source results do not establish a compiled, signed or installed
build-7 app yet.

The [native UI harness](../tests/native-ui/README.md) now covers contact draft
editing/restart, plan creation/completion/history and reminder creation/snooze/
completion/restart with permission denied. The native CI workflow runs that
journey against the actual simulator Release app and preserves its result bundle.
The expanded journey still needs a passing run on the newly compiled build 7;
the prior shorter build-6 result is separate evidence.

Private compiled artifacts, screenshots, result bundles and signing receipts stay
under the ignored mobile build directory. Physical notifications, Contacts,
Calendar, biometrics, accessibility and the real-account integration pilot remain
release requirements.
