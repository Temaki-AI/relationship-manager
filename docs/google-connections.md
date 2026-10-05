# Google account connections

Google Contacts now has a local implementation for separate authorization, address-book review and selected imports. The owner can connect multiple accounts, download contacts, choose fields to create a person or attach to an existing relationship, and retain the original source details through merges, recovery and phone sync. Disconnect and unlink preserve CRM people and private history. Explicit field choices and opt-in recurring downloads now preserve corrections while refreshing saved sources. No real Google account or production deployment has verified this flow yet.

[Gmail metadata](gmail.md) now has its own source implementation for dedicated
consent and an explicit mailbox-label preview. It uses separate encrypted grants
and requires migration 45 before deployment. Login and Contacts consent do not
authorize Gmail. Full message/context synchronization and real-account validation
remain open.

## Configure a development connection

Finish the identity-only login setup in [Development setup](development.md) first. Create a dedicated Google Cloud project for data connections and enable the People API. In its Google Auth Platform, configure the consent audience and test users, then create an OAuth Web application client for this environment. Use separate projects and credentials for local, staging and production.

The connector callback on this computer is `http://localhost:3100/api/connections/google/callback`. Its JavaScript origin is `http://localhost:3100`. The login callback remains `/api/auth/callback/google`; adding Contacts access must not change the login client's requested scopes.

Save the connector client ID and secret in the ignored, owner-readable `.env.development.local` as `GOOGLE_CONNECTOR_CLIENT_ID` and `GOOGLE_CONNECTOR_CLIENT_SECRET`. The implementation rejects reusing the login client ID. Separate Google projects also isolate revocation: Google revokes a user's project-wide grants across that project's clients, so a separate client in the login project alone does not provide independent revocation. [Google token revocation](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke).

`npm run setup:dev` generates `CONNECTOR_TOKEN_KEYRING` for new configuration files. This computer's existing configuration has also received an independent local key without changing its OAuth credentials. The value is a JSON object with `active` naming a key ID and `keys` mapping IDs to unpadded base64url encodings of 32 random bytes. Each key ID has 1–32 letters, digits, underscores or hyphens; at most eight keys are accepted. Keep the entire value quoted in the dotenv file. It is a secret, not a public setting.

For staging and production, provision the connector client secret and token keyring as Worker secrets. Keep independent keys outside D1 and retain a protected key recovery copy. Losing a key makes existing encrypted authorization unreadable; a CRM backup cannot recover it. Do not print keys, use a production key locally or commit credential files.

The consent request asks only for `openid`, `email`, `profile` and `https://www.googleapis.com/auth/contacts.readonly`, with offline access, account selection, consent, state and an S256 PKCE challenge. Gmail and Calendar are not requested. In Google's External Testing mode, these data grants normally receive refresh tokens lasting seven days; expiry requires reconnecting and must not delete imported people. [Google refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration).

Contacts requires migrations 0032–0035. The deployed schema now includes migration
44; the new Gmail source requires migration 45 before a future deployment.
On `/connections/google`, a configured server enables consent and a connected
account offers **Review address book**. Choose **Choose how to save** on a downloaded
contact to review its import. A self-hosted SQLite workspace supports file transfers;
Google connectors require the cloud service.

The Worker configuration declares a separate `GOOGLE_CONTACTS_QUEUE`, with `everclose-google-contacts` and `everclose-google-contacts-failed` as production queue names. Provision both queues in staging before deploying there; this local change has not created remote queues. Local configuration uses distinct `everclose-local-google-contacts` names. Scheduled reconciliation runs every fifteen minutes with the existing maintenance schedule. Local Next development does not run queue consumers or scheduled events automatically; **Continue download** advances one bounded step in the authenticated web app.

## Authorization and storage

`provider_connections` stores the verified Google subject, verified email, granted scopes, owner, workspace, dataset epoch, revision and lifecycle. The Google subject establishes provider continuity; email is a display value and cannot reassign an account. Migration 38 adds a resource purpose: existing grants remain Contacts grants, while [Google Calendar](google-calendar.md) has separate consent and records for the same subject. A workspace may retain ten resource-grant records across purposes, including disconnected records. This bound needs a deliberate removal flow before wider distribution. Google can revoke all clients in one Cloud project together; distinct client IDs alone do not establish independent revocation.

Authorization attempts last ten minutes and are capped at five per owner/workspace. D1 stores only a hash of the random state and an encrypted PKCE verifier. Claiming an attempt is atomic and permits one code exchange; a failed or uncertain exchange requires a new consent attempt. Reauthorization names the original connection and revision, and must return the same Google subject. An owner removed during the exchange cannot commit credentials. Callback redirects strip the code and state, use a fixed app destination and disable referrer transmission.

Access and refresh tokens use AES-256-GCM with a random nonce and authenticated context containing the provider, credential purpose, workspace, owner and record ID. Copying ciphertext to another account or workspace fails authentication. The envelope includes a key version; retain older keys during rotation and refresh or reauthorize before retiring them. Plaintext credentials stay inside server code and never appear in list responses, phone sync, CRM snapshots, exports or application error logs.

The old `integration_connections` snapshot table remains legacy descriptive CRM data. It is not the credential store. Private and portable CRM recovery now use schema version 13, retaining `contact_provider_links` and adding `provider_field_rules`. A saved link contains the verified provider account identity, stable source ID, original and last observed facts, and the names/methods accepted at import. It has no dependency on an operational account record. Provider authorization, attempts, resource checkpoints, runs and previews remain outside CRM recovery. Genuine older snapshots remain readable and default the absent source table to empty.

## Download and review

Downloading is explicit. A connection does not automatically read the address book. The adapter requests contact sources only, retaining names, emails, raw and provider-canonical phone values, company/title and city/region/country. It excludes photos, biographies and street-address fields from the stored preview. Facts are attributed to the individual Google contact source, rather than borrowing fields from another source merged into the same Person response.

The underlying `CONTACT` source ID identifies each record. A Person resource name can change; incremental updates retain the source ID and account while replacing its current resource name. A deletion for an old resource name cannot remove a source that has moved to a new one. [Google Person and source metadata](https://developers.google.com/people/api/rest/v1/people).

Full downloads stage pages in a new generation. Incremental downloads first copy the published generation in batches of at most 100 records, then stage changed records and provider deletions. Only a complete response publishes the generation and its next cursor. Incomplete or malformed responses preserve the last complete preview. Provider deletions affect this preview only; no CRM person, note or relationship is changed.

Requests preserve their field mask, source mask and page size across pagination and incremental calls. An expired sync token restarts a full staged download; the application also requests a full download after six days from the previous full run. Google documents a seven-day token lifetime and rate limits on full downloads. [Google connection pagination and sync](https://developers.google.com/people/api/rest/v1/people.connections/list).

Each step receives at most 50 Person records. Responses are limited to 1 MiB, each stored contact to 24 KiB, each field collection to 100 entries, merged contact sources to ten, previous resource names to twenty, and the published address book to 20,000 contacts. Unsupported data stops the run visibly rather than publishing a truncated collection. These defensive limits are not a production-scale performance claim.

A download request has a UUID receipt and one active run per connection. A 45-second lease and atomic checkpoints prevent competing deliveries from committing the same step. Rate limits use a durable retry deadline; nine consecutive transient failures at a checkpoint stop the run. Completed runs can be redelivered without another provider fetch. Queue reconciliation enqueues at most five eligible runs per maintenance pass, cleans at most 500 inactive preview rows and removes at most 100 terminal runs older than thirty days. This repairs interrupted explicit downloads; recurring synchronization has not been enabled.

The review API searches and returns at most fifty contacts per page, keeps the generation attached to later pages and rejects a review cursor after publication of another generation. It returns no Google page/sync cursor or credentials.

## Selected imports and saved sources

Review one downloaded contact before saving. Create a person with a reviewed name, or confirm a suggested email/phone match or search for an existing person. Name equality is not identity evidence. Choose emails and phones individually; using the Google name on an existing person is a separate choice. Company, title and location remain in the saved source details. Importing preserves private notes, history, family, reminders, existing method IDs and preferred values. Invalid or oversized methods are rejected; the source can still be linked without selecting those fields.

Imports save immutable original facts and initially keep selected values unless the owner opts into following them. Later downloads refresh observations and apply explicit field choices. No write-back to Google is enabled.

The server reads facts from the active authorized source index. Requests identify that generation and fact revision, dataset epoch, authorization revision and the opening target person revision. A single guarded transaction commits the person, source and UUID receipt. Competing imports cannot create duplicate links or leave a partial person. An uncertain response retries the exact choices and key; its receipt resolves the surviving person after a merge. A removed source or changed dataset cannot be recreated by that old receipt.

Saved sources appear on the person's **Sources** page with their original details and accepted fields. Unlink requires the current source revision and dataset epoch; it removes only the source details. Imported methods and private relationship data remain. Phone schema 8 caches the separate read-only `provider_links` projection, including during offline edits. Older acknowledgements preserve the current collection; an explicit empty collection removes it. Existing LinkedIn projections and contact-method contracts remain compatible.

A person may have at most 32 Google source links within a 128 KiB projected collection. Combined person/source device payloads are limited to 1 MiB minus 2 KiB. These limits apply during writes and recovery, and are defensive bounds rather than a measured production capacity.

## Recurring downloads and field choices

Automatic downloads are off by default. The address-book review screen offers manual refresh, daily checks (the suggested starting frequency), or hourly checks. The scheduled Worker starts at most five due accounts per maintenance run, using the existing fifteen-minute schedule; these are approximate check intervals, not delivery-time guarantees. Local Next development still requires explicit continuation or a Worker preview with queues and scheduled events. New address-book entries never create CRM people automatically.

Every completed download reconciles saved sources for the verified Google subject, even with automatic downloads disabled. It publishes the complete preview first, then walks linked sources in bounded checkpoints. Changed observations reach the existing phone projection; original facts stay immutable. If Google removes a source, its saved link becomes unavailable and the person, methods and private history remain. A returning source can resume unchanged followed fields. Oversized source growth keeps the previous usable observation and CRM values, reports a source-capacity issue and continues checking other people.

On a person's **Sources** page, each accepted name, email or phone can **Keep my value** or **Follow Google**. A reviewed import can opt into following its selected values; previous imports remain kept. Following uses saved observations now and future downloads thereafter. Editing or removing a followed value in Everclose creates a sticky override, including edits that later return to the former value. Labels, country hints and preferred-method choices remain under the user's control. **Use saved Google name** or **Use selected Google value** explicitly clears that field's override. Additional saved emails/phones require selection and acceptance before they become CRM methods. Removed methods are restored only through this explicit action, with their original identity and without silently becoming preferred.

Email/phone continuity uses the previous value or a unique matching source label. Array order and Google's primary flag are not identity evidence. Missing, ambiguous or invalid fields keep CRM values for review. Only one Google source may follow a person's name or a given method identity. A merge preserves sources and methods while suspending followed choices for explicit review; it does not choose a winning account.

Field rules are backed up separately from credentials and downloaded previews. Their collection is limited to 128 KiB per person. Portable and private schema-12 recovery retain rules and overrides; genuine older backups default absent rules to keeping existing values. Recovery, permission loss, disconnect and reauthorization discard operational schedules, requiring explicit resumption after reconnect. Changing or disabling a schedule cancels scheduled runs; manual refreshes remain separately authorized.

## Refresh and disconnect

A token with less than a minute remaining requires refresh under a 45-second database lease. Provider requests have ten-second timeouts, reject redirects and bound JSON responses to 32 KiB. Only the current lease, connection revision, owner membership and active dataset can publish refreshed credentials. Rotation retains the old refresh token when Google omits a replacement. Transient failures keep the encrypted grant for retry; `invalid_grant` or missing requested scopes clears usable credentials and requires reconnecting. A People API authorization failure also requires reconnecting; a quota failure preserves authorization for retry.

Disconnect compares the opening revision, immediately stops local source access, clears refresh leases and cancels the owner's pending consent attempts. It then asks Google to revoke the refresh token. Failed revocation retains encrypted material accessible only to revocation handling; the UI distinguishes stopped access from confirmed provider revocation and offers a retry. A late refresh response after disconnect is retained only for revocation, never as an active connection. A newer explicit authorization cannot be overwritten by that response.

The scheduled Worker removes up to 500 expired consent attempts and retries at most five pending revocations per run. Revocation uses its own lease and revision guard. It does not need the original OAuth client secret to remain configured, but it does need the encryption key. Local Next development does not run scheduled events automatically.

## Recovery and write fences

Starting maintenance or changing a workspace epoch clears pending consent attempts and refresh leases. Provider access requires the recorded connection epoch to match the current active dataset. A restore leaves authorization outside the snapshot but displays a reconnect-required recovery state. It never rolls back the Google address book or starts an import automatically.

Download runs bind the account, owner, dataset epoch and authorization revision. Ordinary token refresh changes the credential revision while preserving the authorization revision, allowing a long download to continue. Explicit reauthorization, permission loss, disconnect and recovery cancel active runs and clear provider previews. Owner membership is checked on every step and again when committing its result.

Every provider write must also include the current account, owner, epoch and credential revision returned by `googleConnectionAccess`. Include `providerWriteGuard`, or its `providerGrantCondition` within an idempotent commit guard, in the same D1 transaction as CRM changes. Selected imports also guard the active generation, exact source facts and opening person fields. An HTTP request already in flight cannot be recalled; its result must still pass the transaction guard.

Workspace erasure deletes provider authorization, download state and previews through their ownership references. It does not prove that Google has revoked an external grant. Full account deletion, revocation after removal of an owner, provider-derived fact removal/retention choices and public-release policy checks remain work in the [product plan](product-development-plan.md).

## Verification and remaining gates

Tests cover explicit scopes, state/PKCE, identity checks, account and workspace isolation, key rotation, swapped/tampered ciphertext, refresh serialization and rotation, transient failures, revoked grants, disconnect races, scheduled retry bounds, HTTP origin controls, restoration and erasure. Disposable Worker tests exercise D1 transactions; Google endpoints are test doubles. Download tests cover staged full/incremental publication, changed resource names, tombstones, cursor expiration, capacity overflow, permission loss and generation-bound paging. Import checks cover reviewed create/attach, preserved private fields, exact and concurrent receipts, late commit fences, merging, bounds, phone reconciliation, erasure and regular/private recovery including genuine older manifests. Reconciliation checks cover sticky corrections, explicit resets, additional accepted fields, missing/reappearing sources, merge authority, stale writes, schedule cancellation during fetch, unlink during reconciliation, source capacity and schema-12/older recovery. Browser tests cover desktop/mobile imports, uncertain acknowledgements, field controls, schedule choices, saved source details, unlink, accessibility and horizontal bounds with mocked Google APIs. These checks do not establish real Google consent or provider availability.

Before enabling real use, finish credentials and consent setup, verify an authorized account through the actual callback, and test Google revocation and Testing-mode reconnect behavior. Staging recovery, native device checks and public-release verification remain required. Automatic schedules remain off until the owner explicitly enables them.
