# Gmail context implementation

The source implementation now includes separate owner consent, encrypted grants,
reviewed label/alias/retention choices, durable full and incremental metadata
downloads, reviewed correspondent matching and separate per-person web context.
Interrupted or invalid reads
keep the previous generation until a complete replacement commits. Real OAuth
clients are not configured or verified, and no production Gmail grant, mailbox
read or deployment has occurred. General profile cards and the native offline
transport/cache now have a source implementation described below. Reviewed
activity behavior and the real-account pilot remain unfinished. Consented recurring
downloads now have a tested source implementation described below.

The complete **878-test root suite**, root TypeScript/lint, standalone build and
Cloudflare build pass. The 38 focused consent/download/matching checks pass with
the D1 runtime: 34 run on disposable D1, three preserve prior SQLite data through
migrations 45–47, and one checks pure matching rules. All **20 desktop/mobile
Gmail browser journeys** pass, including explicit choices, reload/resume, exact
retries, pagination, shared-address decisions, exclusions, changed-authorization
and changed-catalog suppression, and confirmation before replacing settings.
The download/matching review passes automated WCAG and viewport checks; its rendered mobile
screen was inspected. These are synthetic fixtures, not a real mailbox pilot.

The additional profile/native transport checks pass **15/15 on disposable D1 with
real mobile SQLite**, including owner/device revocation, bounded paging, scope
changes, offline restart, retained schema-14 data and exact frozen requests.
Eight desktop/mobile profile and Calendar regression journeys pass, including
WCAG and viewport checks. Native TypeScript/lint, five package tests and the
production Hermes export pass for the build-5 candidate. The first complete root
run exposed three simulated-downgrade fixtures that retained schema-15 tables and
two localhost-denied readiness fixtures. After fixing the downgrade fixtures and
allowing fixture localhost access, the complete rerun passes 868/868 with no skips.

Migration 48 is applied only to isolated local D1; production was last verified at migration
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

Apply `0045_google_gmail_consent.sql`, `0046_google_gmail_downloads.sql`,
`0047_gmail_matching.sql` and `0048_gmail_recurring.sql` in
order before deploying this source. Migration 45 permits the dedicated consent
purpose. Migration 46 adds empty operational cache tables and privacy guards;
it preserves prior tables, fields and provider grants. Migration 47 adds a derived
email directory, message participants and private reviewed matching rules/receipts;
its upgrade preserves populated CRM, grants and previously downloaded message facts.
Migration 48 adds default-off cadence and scheduled-run revisions, preserves all
prior fields and gives existing manual runs no automatic consent. The cumulative
ORM snapshot includes migration 48 and the named dispatch indexes; a fresh
schema-generation probe reports no changes. Readiness requires 48. No production
migration was made; installed build 4 remains mobile schema 14 and signed build 5
uses schema 15.

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
the private cache, reviewed matching choices and unfinished runs; canonical people,
notes and interactions remain untouched. Existing-people mode shows current
candidates and previously reviewed addresses. Review-inbox mode also shows unknown
correspondents. Neither mode filters the owner's separate raw source review.

Start a full metadata scan explicitly, then choose **Continue download**. Each
action advances at most ten persisted steps; leaving stops additional requests.
Reload reads the saved run rather than automatically reading Gmail. Uncertain
starts retry the same operation/body; completed/cancelled requests remain
idempotent. After a complete full scan, **Refresh changes** uses the exact saved
history checkpoint. Expired history retains the previous cache. Manual mode asks for a new reviewed
full scan; enabled recurring checks can repair it within the saved limits. [Google synchronization guidance](https://developers.google.com/workspace/gmail/api/guides/sync).

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

## Consented recurring refresh

Automatic refresh starts off for every mailbox. After saving reviewed download
choices, the owner can explicitly enable daily or hourly checks on the web.
Saving the cadence does not read Google. Checks use those same labels, aliases,
retention, subject choice and scan limit. Changing download choices disables the
cadence and requires a fresh opt-in; disabling it cancels unfinished scheduled
runs and removes their staging while preserving the published cache. Separately
requested manual downloads remain available. Devices cannot enable the schedule.

Cron starts at most five due accounts, dispatches at most five eligible runs and
expires at most twenty invalid/abandoned scheduled runs per invocation. Each queue
message advances one persisted step, including at most ten metadata reads. The
queue uses batch size one and at most two concurrent consumers. Dispatch timestamps
rotate eligible accounts fairly. Provider retries respect bounded deadlines;
leases, current owner membership, grant, workspace epoch, choices and schedule
revision are rechecked before reads and atomic publication. Old, duplicate,
foreign-workspace and revoked deliveries cannot publish private metadata.

A failed queue send leaves its committed checkpoint available for Cron to resume.
An expired history checkpoint sets a repair flag; the next enabled check makes a
bounded full replacement within the same saved limits. The old complete generation
remains readable until publication, and removed messages are omitted from a
complete repair. A scan-limit result still reports limited coverage. None of these
checks creates people, interactions or changes last-contacted dates.
[Google history repair](https://developers.google.com/workspace/gmail/api/guides/sync).

The production and local configs declare separate Gmail queues and dead-letter
queues. The production queue has not been provisioned or deployed. Migration 48
and matching code must precede enabling the feature. All ten focused scheduling
checks pass in SQLite and with the D1 runtime (including one genuine populated
SQLite 47-to-48 upgrade). Twelve desktop/mobile download and profile browser
journeys pass, including lost-save recovery, default-off controls, changed choices,
WCAG and viewport checks. The rendered phone browser screen was inspected. These
fixtures do not establish real OAuth renewal, quota behavior or mailbox delivery.

## Review correspondence

Choose **Show correspondence review** after a metadata download. Matching reads
only saved CRM email methods and the retained Gmail cache. Primary and additional
email methods use the same conservative NFC/lowercase identity as the participant
parser; dots and plus tags are retained. It never uses a name as identity evidence.
An ordinary review automatically reconciles one bounded contact-index batch after
creation or method changes. Large imports can use **Prepare contact matching**,
with at most ten batches per action. No partial index is presented as a trustworthy
empty candidate set, and no additional Gmail read is needed to find a later-created
person within the retained window.

Each address shows its message count/date and up to twenty current candidates.
Even a unique candidate requires an explicit choice. Shared addresses start with
no person selected. More than twenty candidates requires contact-method review
before linking. Unknown correspondents can be excluded, or the owner can create
a person/add the email through the normal CRM forms and refresh matching. These
actions never automatically create contacts or copy private metadata into notes.

A reviewed link records the complete candidate set. Genuine merge aliases resolve
to the surviving person; a new shared-address candidate, removed email or deleted
identity suspends correspondence until reviewed again. Exclude and Clear choice
are explicit actions. Choices commit with a receipt and matching revision in one
transaction. Lost replies retry the exact operation/body; replaying an earlier
receipt cannot undo a later choice. At most 20,000 receipts are retained per mailbox
window. Choices and receipts for addresses absent from the retained published cache
expire in the privacy job. Settings/grant/recovery/owner changes purge this private
state. It is excluded from CRM recovery snapshots.

**Show correspondence for [person]** opens a separate paged metadata section from
the reviewed links. One underlying message appears once for that person even when
several reviewed addresses occur in it. Date, uncertain/incoming/outgoing direction,
reviewed addresses and explicitly retained subjects remain observed context; no
interaction is logged and last-contacted is unchanged. Pages pin the source generation,
contact-directory and matching revisions. The server and browser recheck consent,
ownership, recovery and those revisions after reads, suppressing stale results.
Reload discards displayed metadata and unfinished browser selections. General
person profiles now have a short reviewed-context preview, mailbox selection and
bounded older-message pages. Cross-account message correlation and an
observed-to-confirmed activity review flow remain unfinished.

## Profile and native offline transport

`GET /api/v1/gmail-context` is a separate version-1 read protocol; existing frozen
version-4 CRM requests are unchanged. A live owner web or device session can read
a complete bounded catalog of up to 32 saved Gmail resources. Device sessions
cannot manage provider consent, change mailbox choices or confirm matches. The
catalog fingerprint covers authorization, choices, published generations, matching
decisions, contact email identities and recovery epoch. Atomic guards reject
revocation, expiry, owner loss and catalog changes during a read. Cursors also bind
the mailbox and person. Each page contains at most 50 messages and one MiB, with
only IDs, date, direction, consented subject and reviewed addresses; raw
participants, headers, bodies, credentials and unrelated contacts are omitted.

The web profile presents three messages initially and requires an explicit action
to show the rest of a page. It checks the catalog again before displaying a page
and while open; switching away clears displayed private context. No message
metadata enters browser storage or confirmed CRM history.

Native schema 15 adds account-local email state and cached person projections.
Storage defaults off. Enable **Save reviewed email metadata on this phone** in
Account to use the profile card. Active startup/resume/sync checks the complete
catalog. Changing it clears all cached projections, including unopened profiles.
Changing contact email identities, deleting or merging people, recovery,
authorization denial, disabling storage and local disconnect also invalidate
private context. In-flight replies cannot re-enable storage or publish after a
policy/account change. A pending contact-identity outbox entry holds email review;
notes-only edits preserve its separate projection.

Reviewed pages publish atomically and remain readable after restart offline.
They expire after the earliest known grant/device expiry or 24 hours; reconnect
to learn about a revocation that happened while offline. Retention also filters
expired messages and prunes them during catalog refresh. The bounded cache keeps
at most 500 messages, four MiB and 64 person/mailbox projections, evicting older
other profiles when needed. A page that cannot fit preserves the prior complete
cache. The iPhone profile shows five messages initially with explicit expansion
and older-page actions. These tables are private cache, not portable CRM recovery
or an interaction/outbox source.

The installed build 4 still uses schema 14 and does not contain this new source.
Native binary/startup verification and a production API/migration deployment are
required before delivering this integration to that phone. Real mailbox consent
and a controlled pilot remain required; fixture checks do not establish them.

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
2. Validate and deliver the implemented general profile/native context through matching web/native releases and controlled physical-device checks.
3. Deliver reviewed activity behavior and cross-account correlation, preserving private relationship notes and one underlying message identity where the available evidence supports it.
4. Provision and validate the implemented recurring jobs with real-account renewal, history repair, privacy retention, disconnect and dead-letter recovery.

The metadata scope is restricted. Public server-backed use requires the applicable
Google verification/security process; a personal-pilot exception does not establish
public readiness. [Gmail scope classification](https://developers.google.com/workspace/gmail/api/auth/scopes).
