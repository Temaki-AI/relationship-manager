# Gmail context implementation

The metadata transport passes seven provider-boundary fixture tests, root type
checking/lint and the complete 805-test application suite. Gmail is not yet a
usable connection in Everclose: separate owner consent/client configuration,
encrypted credential lifecycle, durable staged storage, reviewed matching,
web/native context and real-account validation remain required. No Gmail grant or
production mailbox read occurs in this implementation step.

## Provider boundary

`lib/cloud/google-gmail.ts` uses only authenticated GET requests against the fixed
Gmail `users/me` endpoint, rejects redirects, applies a request deadline and bounds
all response streams and arrays. Provider error details and credential-bearing
exceptions never become user messages or logs.

Profile reads establish the mailbox email and string history checkpoint. Label
reads retain only identity/name/type. Message lists return at most 100 identities
per page and scan one selected label at a time: multiple Gmail label IDs mean an
intersection, not a union. The metadata grant forbids the search `q` parameter,
so a date window must be applied after bounded metadata reads. Reaching a scan
limit cannot be reported as complete coverage of that window.
[Message list contract](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list).

Message reads request `format=metadata` and an explicit header allowlist. Returned
bodies, snippets, parts, attachments and unrequested headers are discarded. Subject
headers are requested/returned only when the caller explicitly opts in; a future
settings/storage decision must remain default-off. Transport headers are temporary
input for participant parsing, not a canonical stored activity record.
[Metadata reads](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get).

History reads retain added/deleted messages and label changes, with uint64 IDs
kept as exact strings. Generic duplicate message projections are omitted. History
pages must all commit before advancing the mailbox checkpoint. Label-change hints
require current metadata reads. An expired history ID returns a distinct repair
condition; it does not delete saved relationship history. Missing messages,
permission failures, malformed data and bounded retry delays remain distinct.
[History and repair contract](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list).

## Remaining complete integration

1. Add a separate metadata-only consent purpose, dedicated client and vault lifecycle; preserve current Contacts/Calendar permissions and Google's project-wide revocation behavior.
2. Persist explicit labels, account aliases, existing-people/review-inbox mode, bounded history/scan limits and default-off subject retention. Show filtering and incomplete-coverage limits before connecting.
3. Stage full/incremental metadata with durable page leases/checkpoints, atomic publication, restore/account fences and bounded repair. Preserve old context during interrupted or invalid reads.
4. Parse participants, remove self aliases and classify bulk/automated traffic from evidence. Keep one source message with multiple participants, stable provider IDs and explicitly reviewed contact matches. Creating a person later reruns matching over the retained authorized window.
5. Deliver web/iPhone context and reviewed activity behavior without silently creating people, claiming a sent reply or changing private relationship notes. Complete disconnect/retention, recurring refresh and real-account tests.

The metadata scope is restricted. Public server-backed use requires the applicable
Google verification/security process; a personal-pilot exception does not establish
public readiness. [Gmail scope classification](https://developers.google.com/workspace/gmail/api/auth/scopes).
