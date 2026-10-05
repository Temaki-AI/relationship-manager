# Gmail context implementation

The source implementation now includes separate owner consent, encrypted grants,
reviewed label/alias/retention choices, durable full and incremental metadata
downloads and paged review of the published cache. Interrupted or invalid reads
keep the previous generation until a complete replacement commits. Real OAuth
clients are not configured or verified, and no production Gmail grant, mailbox
read or deployment has occurred. Reviewed contact matching, relationship context,
recurring downloads and native Gmail context remain unfinished.

The complete **839-test root suite**, root TypeScript/lint, standalone build and
Cloudflare build pass. The 24 consent/download/migration checks pass with the D1
runtime: 22 use disposable real D1 and two compare prior SQLite tables/fields
through migrations 45 and 46. All **12 desktop/mobile Gmail browser journeys**
pass, including explicit choices, reload/resume, frozen start retries, pagination,
changed-authorization suppression and confirmation before replacing settings.
The download review passes automated WCAG and viewport checks; its rendered mobile
screen was inspected. These are synthetic fixtures, not a real mailbox pilot.

Migration 46 is applied only to isolated local D1; production remains at migration
44. The installed personal iOS build remains build 4 with mobile schema 14. Its
physical launch and process-stability checks pass; Gmail context is not in that app.

## Configure and preview an account

Create a dedicated OAuth Web application client with the Gmail API enabled,
configure its audience/test users and use the environment's origin plus
`/api/connections/google/callback` as its redirect URI. Store its credentials as
`GOOGLE_GMAIL_CLIENT_ID` and `GOOGLE_GMAIL_CLIENT_SECRET`, with the existing
`CONNECTOR_TOKEN_KEYRING` vault format from [Google connections](google-connections.md).
The implementation rejects sharing client IDs with login, Contacts, Calendar
reading or Calendar publishing. Use a separate Cloud project when independent
revocation is required; clients in one project can be revoked together.

Apply `0045_google_gmail_consent.sql` and `0046_google_gmail_downloads.sql` in
order before deploying this source. Migration 45 permits the dedicated consent
purpose. Migration 46 adds empty operational cache tables and privacy guards;
it preserves prior tables, fields and provider grants. Readiness requires 46.
Production remains at migration 44, and mobile schema stays 14.

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

## Review choices and download metadata

Select 1–20 labels from the explicit mailbox preview, add up to twenty own aliases,
choose 1–90 past days and a 100–10,000 message scan limit. Subjects start disabled
and require a separate checkbox. The primary mailbox is always excluded from
participants; aliases keep their dots and plus tags. Save validates the current
provider labels and the opening owner/epoch/authorization/settings revisions.
An identical save is idempotent. Changed choices require confirmation and purge
the private cache and unfinished runs; canonical people, notes and interactions
remain untouched. The existing-people/review-inbox preference is saved for the
forthcoming matching/context layer; it does not filter this owner's raw source review.

Start a full metadata scan explicitly, then choose **Continue download**. Each
action advances at most ten persisted steps; leaving stops additional requests.
Reload reads the saved run rather than automatically reading Gmail. Uncertain
starts retry the same operation/body; completed/cancelled requests remain
idempotent. After a complete full scan, **Refresh changes** uses the exact saved
history checkpoint. Expired history asks for a new reviewed full scan and retains
the previous cache. [Google synchronization guidance](https://developers.google.com/workspace/gmail/api/guides/sync).

Each step uses an expiring lease and rechecks the owner, workspace, epoch, grant,
settings, base generation and run revision after provider reads. Page-token cycles,
oversized history, malformed input and downloads older than an hour cannot publish.
Retries honor a bounded provider delay. New arrivals during a scan are reread before
the checkpoint advances. A complete publication swaps the generation and checkpoint
in one D1 transaction; a failed publication can retry its durable step. A late cancel
cannot erase a completed cache. Reauthorization, disconnect, changed settings,
owner loss or recovery purges private projections and fences late replies.

**Show downloaded metadata** reads the published cache only. Pages contain up to
50 messages, are pinned to a generation, and use a date/message cursor; a replaced
generation requires a fresh first page. The UI checks authorization again before
displaying a reply and discards displayed metadata on reload. No labels, messages
or aliases are written to browser storage. The scheduled privacy job expires old
messages and abandoned staging without making provider reads. Raw Gmail caches
are excluded from portable/cloud CRM recovery snapshots.

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
headers are requested/returned only with the saved default-off subject choice.
Transport headers are temporary
input for participant parsing, not a canonical stored activity record.
[Metadata reads](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get).

The bounded participant parser accepts explicit address lists, quoted display
names, comments and groups. Unsupported quoted local parts, domain literals,
malformed dot atoms or structural ambiguity are marked incomplete; addresses are
never guessed into contact matches. It retains one message with distinct participant
roles, removes own aliases and filters bulk/automated traffic when headers provide
that evidence. Incoming/outgoing direction needs a complete, unambiguous sender
and appropriate recipient/Sent evidence; other messages remain uncertain. Stored
facts contain no raw headers, display names, bodies, snippets or attachments.
Nested SQL guards reject private extra fields, duplicate participants/roles, own
addresses and subjects without consent.

History reads retain added/deleted messages and label changes, with uint64 IDs
kept as exact strings. Generic duplicate message projections are omitted. History
pages must all commit before advancing the mailbox checkpoint. Label-change hints
require current metadata reads. An expired history ID returns a distinct repair
condition; it does not delete saved relationship history. Missing messages,
permission failures, malformed data and bounded retry delays remain distinct.
[History and repair contract](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list).

## Remaining complete integration

1. Configure the dedicated clients/vault in an isolated pilot environment and validate actual consent, expiry, reconnection and Google's project-wide revocation behavior.
2. Match retained participants to current contact methods with explicit ambiguity/exclusion review, respecting the saved existing-people/review-inbox mode. Creating or editing a person must rerun matching over the authorized retained window.
3. Deliver separate web/iPhone correspondence context and reviewed activity behavior, preserving private relationship notes and one underlying message identity across participants/accounts.
4. Add consented recurring download jobs with bounded delivery/recovery, then validate real-account renewal, history repair, privacy retention and disconnect behavior.

The metadata scope is restricted. Public server-backed use requires the applicable
Google verification/security process; a personal-pilot exception does not establish
public readiness. [Gmail scope classification](https://developers.google.com/workspace/gmail/api/auth/scopes).
