# Calendar rescheduling

Status on 6 October 2026: implemented and verified locally for desktop and mobile
web. This change has not been deployed to production and does not change the
compiled iPhone application.

Open plans and reminders have a Reschedule action in the month detail and agenda.
The dialog loads the current record before review. Plans use a civil date;
reminders use local date and time with the resulting timezone displayed. An
invalid date or a local time normalized across a daylight-saving gap cannot be
submitted. Saving selects the new month and day.

Only the chosen date changes. Person, title, type, private notes, completion and
interaction history stay intact. Changing an Everclose plan does not publish or
reschedule its linked Google or Apple event. Provider changes require their
separate existing review.

GET `/api/plans/:id` and `/api/reminders/:id` return a current `schedule_revision`.
A date-only PATCH contains `calendar_schedule` with `expected_revision`,
`original_at` and `at`. Mixed edits are rejected. The revision covers the record's
identity, person, editable fields, completion and recovery epoch. The conditional
SQL update checks the reviewed fields again at commit; cloud writes also require
the same active, unpaused workspace epoch. Local updates run inside the existing
maintenance lock and an immediate SQLite transaction.

A lost reply can be confirmed by sending the identical request again. It returns
the saved date without another write or journal revision. While this dialog stays
open, its exact request is retained and the input stays disabled until the retry
is confirmed. This is an in-memory dialog retry, not a durable browser outbox.
A definitive conflict requires an explicit fresh review and retains the proposed
date. Completed or deleted records cannot be rescheduled.

Verification uses disposable records and storage: SQLite/cloud regression tests,
five actual D1 cases, and four desktop/mobile browser cases covering existing
capture/completion plus date changes, month navigation, a lost reply and a
concurrent private-note edit. Browser checks include accessibility and horizontal
overflow. Types, lint, Cloudflare compilation and Worker dry run pass. These are
local checks; real production account and provider effects are separate gates.
