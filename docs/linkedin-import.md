# LinkedIn connections export import

This is a locally verified part of the [personal-first product plan](product-development-plan.md).
It supports user-provided `Connections.csv` files and profile URLs. It does not authorize
a LinkedIn account, fetch profiles or provide recurring LinkedIn synchronization. No
production migration or deployment has occurred.

## Review and save

Open LinkedIn profile links and choose Import a LinkedIn Connections.csv export. Select `Connections.csv`
from the downloaded archive. The browser parses the file in memory, accepting at most
2 MiB and 5,000 rows, with 50 rows per page. It supports a BOM, the Notes preamble,
quoted values, escaped quotes and accented names. Unrelated archive categories,
malformed headers and oversized files are rejected. Invalid rows remain visible and
cannot be saved. An older export without URLs requires a valid profile URL during review.

Only row previews and confirmed row requests are sent to Everclose. Name and email
matches are suggestions; the user must choose a new person or an existing relationship.
An already linked profile must be reviewed against its current person. Moving a profile
requires explicitly unlinking it first. Reimporting the same canonical profile updates
one source rather than creating another person.

Each confirmed row retains supplied name, profile URL, email, company, position and
connection-date context as user-provided facts. Original and latest observations remain
separate. Connection dates do not automatically create interactions or establish the
time of a conversation. Names and text are normalized under the source contract; this
is not an archival copy of the CSV or the full LinkedIn download.

For a new person, confirm the name to use. For an existing person, replacing the name
is an explicit choice. Adding the exported email is also optional. Existing preferred
emails, method identities, private notes and relationship history are preserved. Company,
position and connection date remain source context. Unlinking removes source details
while retaining accepted contact fields and the relationship.

## Retry, conflicts and recovery

Each row confirmation has a frozen request body and UUID. The contact changes,
source facts and receipt commit together. An uncertain response pauses editing and offers
an exact retry; a different body cannot reuse that UUID. A successful retry follows a
merge to the surviving person, and a removed source cannot be recreated by its old receipt.

When available, browser tab session storage retains only the unconfirmed row request,
keyed by the authenticated workspace's dataset epoch. Reload checks the current scope
before offering retry. It does not retain the whole file or resume the entire review list;
reselect the file to continue other rows. Storage failure is reported before confirmation.
Closing the tab can clear its session storage. Restore changes the epoch and requires
fresh review instead of replaying pre-restore choices.

Person and source revisions reject stale choices before writing. Concurrent confirmations
and competing initial profile links cannot leave duplicate effects or orphan people.
Source-count, byte and complete-device-record limits roll back contact edits and the
receipt together. Local SQLite uses durable receipts outside ordinary short-lived
create-receipt cleanup; Cloudflare uses the workspace's existing mutation receipt table.
These receipts are operational state rather than CRM backup content.

## Device and release compatibility

Migration `0037_linkedin_export_fields.sql` extends source fact validation with `email`,
`title` and `connected_on`. It preserves the existing tables, eleven-column source-link
projection, immutable originals and revision guards. Email is limited to 320 characters,
name to 200, and the other source text fields to 500.

Saved observations travel through the existing read-only source projection. Merge,
portable/private schema-13 recovery and a freshly bootstrapped native offline cache
retain all seven fact kinds. CSV/vCard transfers continue to contain accepted CRM values
rather than raw source observations. Native source editing still uses the web.

The fact vocabulary is a compatibility change even though the projection columns and
snapshot version are unchanged. Earlier prototype clients strictly accept four fact
kinds and can reject records containing the new kinds. Use matching web and native
builds before staging or public distribution; do not claim compatibility with those
older binaries. Current JavaScript/native domain checks do not prove a compiled binary
or a physical iPhone journey.

Before release, verify an actual owner's export, authenticated Google/device access,
staging migration and recovery, and a supported native build on an iPhone. Broader source
availability, calendars, Gmail and public-release operations remain work in the full plan.
For how to request the file and which fields LinkedIn supplies, see
[LinkedIn's account-data instructions](https://www.linkedin.com/help/linkedin/answer/a1339364/downloading-your-account-data?lang=en).
