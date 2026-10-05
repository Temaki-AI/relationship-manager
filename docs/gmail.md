# Gmail context implementation

The source implementation now includes separate owner consent, an encrypted
credential lifecycle and an explicit, read-only mailbox-label preview. The
metadata transport has seven provider-boundary fixture tests; eight consent and
lifecycle journeys also pass against isolated real D1, alongside a migration
preservation check. Real OAuth clients are not configured or verified, and no
production Gmail grant or mailbox read has occurred. Durable message staging,
reviewed matching and web/iPhone relationship context remain unfinished.

The complete 814-test root suite, root TypeScript/lint, standalone build and
Cloudflare build pass. Migration 45 is applied to the isolated local D1 database;
production remains at migration 44.
All 16 targeted desktop/mobile browser journeys pass, including the existing
Contacts/Calendar flows, explicit Gmail consent/preview, label search/paging,
discard on reload and changed-authorization handling. The preview passes the
automated WCAG checks and fits the mobile viewport. These are isolated fixtures,
not evidence of a production mailbox or native Gmail context.

## Configure and preview an account

Create a dedicated OAuth Web application client with the Gmail API enabled,
configure its audience/test users and use the environment's origin plus
`/api/connections/google/callback` as its redirect URI. Store its credentials as
`GOOGLE_GMAIL_CLIENT_ID` and `GOOGLE_GMAIL_CLIENT_SECRET`, with the existing
`CONNECTOR_TOKEN_KEYRING` vault format from [Google connections](google-connections.md).
The implementation rejects sharing client IDs with login, Contacts, Calendar
reading or Calendar publishing. Use a separate Cloud project when independent
revocation is required; clients in one project can be revoked together.

Apply migration `0045_google_gmail_consent.sql` before deploying this source.
It changes only the permitted consent-purpose insert guards; the preservation
test compares every existing table and field after applying the genuine prior
migrations. Production remains at migration 44 until this change is deployed.
Mobile schema stays 14, and the installed iOS build is unaffected.

Open `/connections/google/gmail` in the signed-in owner's cloud workspace. Consent
requests only `openid`, `email`, `profile` and `gmail.metadata`, with offline access,
one-use state and S256 PKCE. Completion verifies that the Gmail mailbox matches
the verified Google identity before committing encrypted credentials. Reconnect
must select the same Google subject. Cancelled attempts return to the trusted
Gmail page; arbitrary callback query parameters cannot select a redirect.

Choose **Preview mailbox labels** explicitly. Opening the preview page reads only
the connection state; the button reads mailbox identity and label identities,
names and types. No messages or subjects are imported, no relationship history
changes and no labels are persisted or placed in browser storage. Leaving or
reloading discards the preview. Ownership, authorization and recovery guards are
checked after provider reads, and the UI rechecks the connection before displaying
results. Disconnect or a changed grant suppresses in-flight private results;
provider permission loss requires reconnection. A new preview requires the
current epoch and authorization revision.

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

1. Configure the dedicated clients/vault in an isolated pilot environment and validate actual consent, expiry, reconnection and Google's project-wide revocation behavior.
2. Persist explicit labels, account aliases, existing-people/review-inbox mode, bounded history/scan limits and default-off subject retention. Show filtering and incomplete-coverage limits before connecting.
3. Stage full/incremental metadata with durable page leases/checkpoints, atomic publication, restore/account fences and bounded repair. Preserve old context during interrupted or invalid reads.
4. Parse participants, remove self aliases and classify bulk/automated traffic from evidence. Keep one source message with multiple participants, stable provider IDs and explicitly reviewed contact matches. Creating a person later reruns matching over the retained authorized window.
5. Deliver web/iPhone context and reviewed activity behavior without silently creating people, claiming a sent reply or changing private relationship notes. Complete disconnect/retention, recurring refresh and real-account tests.

The metadata scope is restricted. Public server-backed use requires the applicable
Google verification/security process; a personal-pilot exception does not establish
public readiness. [Gmail scope classification](https://developers.google.com/workspace/gmail/api/auth/scopes).
