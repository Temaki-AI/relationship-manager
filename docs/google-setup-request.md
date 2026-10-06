# Google setup prepared for owner approval

The existing hosted Google sign-in remains in its current project. This proposed
setup creates three projects and nine **Web application** OAuth clients. Projects
stay unbilled; no billing account is linked. These configuration actions do not
grant access to Contacts, Calendar or Gmail. Each grant still requires a separate
review and consent through Everclose, and downloads remain explicit/default-off.

| New project name | New client names | APIs to enable |
| --- | --- | --- |
| Everclose local sign-in | Everclose local login | Identity only; no data API |
| Everclose local integrations | Everclose local Contacts; Everclose local Calendar reading; Everclose local Calendar publishing; Everclose local Gmail metadata | People, Calendar, Gmail |
| Everclose personal integrations | Everclose personal Contacts; Everclose personal Calendar reading; Everclose personal Calendar publishing; Everclose personal Gmail metadata | People, Calendar, Gmail |

Google assigns each project a unique ID during creation. The local sign-in
project stays separate from all data projects. Each resource purpose gets a
distinct client ID. [Google revocation applies across clients and scopes in the same
project](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke), so data clients in the same project can be revoked together;
the product already reports that consequence and requires reconnecting affected
grants. No existing production client or project is changed.

| Clients | JavaScript origin | Only authorized redirect URI |
| --- | --- | --- |
| Local login | `http://localhost:3100` | `http://localhost:3100/api/auth/callback/google` |
| Four local data clients | `http://localhost:3100` | `http://localhost:3100/api/connections/google/callback` |
| Four personal data clients | `https://everclosecrm.com` | `https://everclosecrm.com/api/connections/google/callback` |

Keep each consent audience in External Testing with only the owner's chosen
Google account as a test user. Configure identity scopes and each purpose's
existing minimum resource scopes from `lib/cloud/google-provider.ts`; publishing
uses `calendar.app.created`, while [Gmail uses `gmail.metadata` without message
bodies or attachments](https://developers.google.com/workspace/gmail/api/auth/scopes).
[External Testing data refresh grants normally expire after seven
days](https://developers.google.com/identity/protocols/oauth2#expiration).
This is personal pilot setup, not public OAuth verification.

Download the local Web client JSON files and import them through
`npm run setup:google -- --purpose <purpose> --file <path>`, beginning with login.
The importer enforces exact localhost callbacks/origins, distinct clients and
separate login/data projects, preserves session/vault secrets and writes only the
owner-readable local configuration. It never prints credential values or reads
provider data. Personal client credentials require independent Worker secrets
and the existing credential-vault runbook; they cannot be imported locally.

Google Contacts/Calendar already have production schema support. Gmail remains
undeployed and requires a separately verified 44-to-48 migration, queue setup and
matching source rollout before its personal connection can be used. Staging needs
separate resources and credentials; none are created by this request.

Creation awaits explicit owner approval because automatic approval review earlier
rejected a new Google project as an unapproved persistent external resource.
The Mac is locked, and the prepared Google console tab currently times out when
controlled. Browser setup also needs the Mac manually unlocked. The existing
Google projects, clients and grants have not been changed.
