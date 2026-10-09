# Developing Everclose on this computer

The default `npm run dev` runs the cloud application with Google authentication and
locally simulated D1/R2 bindings. Cloud and SQLite versions share screens but use
different API implementations. Use cloud mode for work intended for everclosecrm.com.

## First setup

Use Node 22.21.1 (`.nvmrc`) and npm 10.9.4 (`packageManager`), then run:

```sh
npm ci
npm run setup:dev
```

Setup generates an independent signing secret in `.env.development.local`, with
owner-only permissions. It preserves an existing file and never prints its values.
It applies the checked-in SQL migrations only to the local D1 database. No Cloudflare
login is necessary for local development. Existing `data/relationships.db` files
belong to the separate SQLite app and are neither imported nor deleted.

## Google OAuth

In [Google Auth Platform → Clients](https://console.cloud.google.com/auth/clients),
select a dedicated local sign-in project, separate from Google data connections.
Create a **Web application** OAuth client named **Everclose local login**.
The [prepared setup record](google-setup-request.md) lists the proposed projects
and clients; their creation still awaits explicit approval. Leave the production
client intact.

| Setting | Value |
| --- | --- |
| Authorized JavaScript origin | `http://localhost:3100` |
| Authorized redirect URI | `http://localhost:3100/api/auth/callback/google` |

If the consent screen is in Testing, add your Google account under Audience → Test
users. Only identity scopes are needed (`openid`, `email`, `profile`); Google Contacts,
Gmail, and Calendar permissions are not part of sign-in. Complete any required consent
screen setup in the console using the owner's authorized Google account.

Put the new client ID and client secret in `.env.development.local`:

```dotenv
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

Keep the generated `BETTER_AUTH_SECRET`. Do not paste secrets in chat, commit them,
reset the production client, or reuse the production session secret. A downloaded
client JSON file can be imported without printing credentials:

```sh
npm run setup:google -- --purpose login --file /absolute/path/downloaded-client.json
```

Use Google's Web application export with only the localhost origin/callback above.
The importer rejects installed-app exports, production/shared callbacks, duplicate
client IDs and a login project reused for data connections. It records the project
ID, preserves unrelated settings and the existing session/vault secrets, and
writes the ignored file atomically with owner-only permissions.

```sh
npm run check:dev
npm run dev
```

Open **http://localhost:3100** consistently, including when signing in: `127.0.0.1`
is a different OAuth origin. After the Google redirect, this local D1 instance creates
your own empty workspace. Signing in with your production account does not copy its
contacts. An `invalid_client` error means the credential values need checking;
`redirect_uri_mismatch` means the exact callback above is missing from the client.

## Google data connections

Google sign-in grants only identity access. Each data purpose needs a distinct Web
client ID, with `http://localhost:3100` as its sole origin and
`http://localhost:3100/api/connections/google/callback` as its sole redirect.
Use a data project separate from the sign-in project. Google can revoke multiple
data clients together when they share a project.

Import the downloaded clients individually after importing login:

```sh
npm run setup:google -- --purpose contacts --file /absolute/path/contacts-client.json
npm run setup:google -- --purpose calendar --file /absolute/path/calendar-client.json
npm run setup:google -- --purpose calendar-publish --file /absolute/path/publishing-client.json
npm run setup:google -- --purpose gmail --file /absolute/path/gmail-client.json
```

Contacts is read-only; Calendar reading and app-created calendar publishing use
separate consent. Gmail requests metadata without message bodies or attachments.
Importing credentials does not authorize a provider, download data or enable
automatic refresh. Real authorization for these four purposes remains unverified.
See [Google Contacts setup](google-connections.md), [Calendar setup](google-calendar.md)
and [Gmail setup](gmail.md) for their consent and review flows.

New setup files receive an independent connector encryption key; existing files are
preserved. This computer's local file has received its key separately. Address-book downloads, reviewed create/attach imports and opt-in bounded updates are implemented and verified locally. The connection has not passed a real Google authorization journey.

Cloud development takes all five Google clients, project IDs, the connector keyring
and session secret only from `.env.development.local`. Missing local values become
empty even if the shell contains credentials. This prevents accidentally inheriting
another environment's Google clients or vault/session keys. Keep the independent
local secrets generated by setup; production credentials cannot be imported here.

## Development commands

| Command | Purpose |
| --- | --- |
| `npm run dev` / `npm run dev:cloud` | Next.js hot reload, cloud handlers, Google sign-in, local D1/R2 |
| `npm run setup:dev` | Create the ignored configuration if absent and migrate local D1 |
| `npm run setup:google -- --purpose <purpose> --file <path>` | Import a dedicated localhost Google Web client without printing credentials |
| `npm run check:dev` | Check configuration and storage isolation without showing credentials |
| `npm run db:migrate:local` | Apply new migrations only to the isolated local D1 database |
| `npm run preview:cloud` | Build and run the app locally in the Workers runtime on port 3100 |
| `npm run dev:local` | Explicit legacy SQLite development, without demo seeding |

Stop the dev server before starting preview or a build; they share `.next` output
and port 3100. Hot reload uses Node with local binding proxies; preview executes
the built Worker in workerd. Cron does not run automatically in the Next dev server.
Use disposable Worker tests for scheduled/queue behavior; live OAuth, service quotas,
email delivery, and production recovery still require separately controlled checks.
Calendar event refresh is a separate opt-in schedule on each selected calendar's events
page. Migration 42 and `GOOGLE_CALENDAR_QUEUE` are required; its local binding uses
`everclose-local-google-calendar` and the matching failed queue. Authorization or calendar
selection alone never enables automatic downloads. See [Calendar connections](google-calendar.md).

`wrangler.local.jsonc` contains no production domain or database identifier. D1/R2
bindings and the self-service binding explicitly disable remote access. Storage is
persisted beneath `.wrangler/everclose-local/v3` for both dev and preview. The Next
proxy receives the `v3` path, while Wrangler's `--persist-to` receives its parent.
Email delivery, automatic backups, and large recovery stay disabled by default.
Do not use `--remote` or the production Wrangler configuration for development data.

## Validation and release

Run `npm test`, `npm run lint`, and `npx tsc --noEmit` for source changes. For cloud
behavior also run `npm run test:cloud`, and relevant browser journeys. Tests use
disposable storage; a successful configuration check alone does not prove OAuth works.

Production remains configured in `wrangler.jsonc`. `npm run deploy:cloud` and
`npm run db:migrate:remote` affect live resources and are separate release actions.
Do not run either as part of local setup.

The [4 October personal web release](personal-web-release.md) verified real Google
identity sign-in on migration 44. Its subsequent shared Today preference extension
is deployed as Worker version `370949af-afef-44e2-8578-900625e1ce0d`, also on migration
44. Local OAuth credentials remain a separate setup step; Gmail migrations 45–48
and bindings have not been deployed.

On October 3, 2026, Cloudflare reported the then-active production version as
`a0a51687-c80c-407c-a097-8fb98e1b640d`, tagged `release-2026-10-03`, with deployment
message `release-2026-10-03-53631a8`. This matches the pulled base commit; subsequent
local edits are not deployed automatically.

References: [OpenNext development workflow](https://opennext.js.org/cloudflare/howtos/dev-deploy),
[Cloudflare local environment variables](https://developers.cloudflare.com/workers/local-development/environment-variables/),
[Better Auth Google setup](https://better-auth.com/docs/authentication/google).
