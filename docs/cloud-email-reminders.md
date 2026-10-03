# Cloud Email Reminders

This is an opt-in, cloud-only delivery channel for explicit timed reminders and
contact or child birthday alerts. It does not email cadence suggestions or a
weekly digest. The existing browser channel still requires the
app to be open.

## Before Activation

1. Apply all pending migrations through `0014_modern_bloodstrike.sql` to the target D1 database. Deploy
   this source before turning on delivery so the API and Cron agree on the schema.
2. Onboard and verify `everclosecrm.com` for Cloudflare Email Sending. Confirm that
   `alerts@everclosecrm.com` is an allowed sender and that the account can send to
   its intended recipients. The current Wrangler OAuth token cannot inspect or
   configure Email Sending, so none of these prerequisites has been verified here.
3. Add a Wrangler Email Sending binding named `EMAIL` to `wrangler.jsonc`, with the
   allowed sender address restricted to `alerts@everclosecrm.com`. Keep
   `EMAIL_FROM` set to that address. The Worker expects the binding's `send()` API.
4. Send an operator-controlled test message, inspect the Email Sending delivery
   result, then change `EMAIL_DELIVERY_ENABLED` from `false` to `true` and redeploy.
   Do not flip the flag just to test the UI; doing so permits verified users to opt in.
5. Run an authenticated production smoke test with a dedicated account: enable the
   channel, create a near-future reminder, close the app, and confirm one email
   arrives after the Cron fires. Repeat with a contact birthday inside its lead
   window, with a child birthday, during quiet hours, after opt-out, and after a cloud restore.

The scheduled Worker runs every 15 minutes. A due event is identified by workspace,
user, reminder ID, and due instant. New opt-ins do not send historical overdue
reminders. Each invocation enqueues at most 500 unseen events, considers at most
500 queued reminder events, and sends at most eight reminder emails, each combining
up to 20 due reminders for one account. A separate round-robin scan examines at
most 2,000 contact birthdays and 2,000 child birthdays per pass, with separate
persistent cursors. It records one event per contact or child, account, and
annual occurrence. Child birthdays have a fixed seven-day notice window, separate
from the contact's own lead-days setting. It can send at most eight birthday emails per pass, each
combining up to 20 birthday alerts. Both queues use a five-minute claim lease,
exponential retries, and a terminal failure after five attempts. The Reminders page shows the last send
and the number of terminal failures. Quiet-hour events are deferred until the next
allowed local time, including daylight-saving transitions, rather than blocking
other recipients. Birthday lead days and local dates use the same civil-date policy
as the browser calendar, including observing February 29 on March 1 in non-leap
years. Emails contain only a count, a generic prompt, and a link, never
a contact name, reminder title, or notes.

Each birthday scanner is bounded to 2,000 person/account pairs per Cron pass and
advances a persistent cursor. A workspace much larger than one full scan cycle
can receive a same-day alert late; measure scan-cycle latency and shard this job
before promising birthday delivery at public scale. A child-list entry can be
linked to an existing contact profile. Once linked, the contact profile is the
single birthday source in the calendar and email scanner. Unlinked child entries
remain independent occasions; users must explicitly link duplicate records.

The queue is at-least-once, not exactly-once: if the provider accepts a message but
the Worker loses its response or the delivery-record update fails, a retry may send
a duplicate. Keep this limitation in user-facing promises. This first release does
not provide a scheduled weekly digest, manual retry of terminal failures, or proof
of live delivery until the operator smoke test succeeds. Account preferences are
intentionally separate from CRM backup snapshots; restoring data clears the
delivery ledgers and turns email alerts off until the user opts in again. That
prevents silent duplicate birthday or reminder email after source replacement.
Workspace erasure removes preferences and deliveries.

References: [Cloudflare Email Sending Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/),
[send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/),
and [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
