# Personal Relationship Manager

A local-first personal CRM to help you maintain meaningful relationships. Track contacts, log interactions, monitor relationship health, and keep important moments in view.

## Features

- 📊 **Relationship Health Dashboard** - Visual health scores based on contact frequency
- 👥 **Contact Management** - Full contact profiles with tags, notes, and gift ideas
- 🖼️ **Private Contact Photos** - Local uploads are resized and stripped of metadata before storage
- 💬 **Interaction Logging** - Track calls, messages, meetups, and emails
- 🔔 **Reminders** - In-app follow-up queue with optional privacy-safe browser alerts while Bonds is open
- 👨‍👩‍👧 **Contact Groups** - Organize contacts (Family, Work, etc.) (NEW in v1.1)
- ⚙️ **Custom Fields** - Add your own data fields (NEW in v1.1)
- 📥 **Contact Transfer** - Import and export standard vCard or CSV files with duplicate protection
- 🧹 **Duplicate Cleanup** - Compare exact matches and merge complete relationship histories safely
- 🛟 **Verified Backups** - Automatic and pre-change SQLite snapshots, retention, and guarded restore
- 🎂 **Birthday Reminders** - Upcoming birthdays at a glance
- ⚠️ **Action Items** - See who you should reach out to
- 🔍 **Search & Filter** - Find contacts by name, tags, or notes
- 📱 **Mobile Responsive** - Works great on phone, tablet, and desktop
- 🏠 **Installable** - Add Bonds to a phone or desktop home screen from a supported browser

The Data Connections screen lists only workflows that are implemented in the current
release. vCard and CSV transfer, encrypted backups, and the optional LinkedIn browser
capture are explicit user-triggered operations. Bonds does not claim or manufacture
Google, Microsoft, email, or calendar sync state; those accounts are not read
automatically.

Product direction is documented in the [competitive analysis and phased roadmap](docs/competitive-analysis-roadmap.md).

The current [product development plan](docs/product-development-plan.md) covers the shared web/iOS experience, connected contacts, email and calendar synchronization, and release milestones.

## Tech Stack

- **Next.js 15** - React framework with App Router
- **SQLite** (better-sqlite3) - Local database, no cloud required
- **Tailwind CSS** - Utility-first styling
- **TypeScript** - Type safety
- **Lucide React** - Beautiful icons

### Native iOS Foundation

The offline-first Expo application lives in `apps/mobile` with an independent lockfile.
It includes account sign-in through the system browser, revocable phone sessions,
separate SQLite caches for each account, a durable workspace outbox, manual capture and
reviewed selected iPhone Contacts import/attachment, relationship touch logging, and
iOS-scheduled local reminders. Selected fields sync with the account; saved iPhone source
details currently remain on the choosing phone. Ongoing iPhone address-book sync remains
planned.
The development implementation syncs contacts, interaction history, reminders, plans,
family and relationships with the cloud service and offers review of conflicting or
pre-restore edits. Native agenda and context forms support offline editing and confirmed
plan completion without duplicate interaction history.
Server migrations 0024–0035, real Google OAuth and a device journey
must be verified before rollout; these changes have not been deployed. See the
[mobile guide](apps/mobile/README.md) and [sync protocol](docs/contact-sync.md).

## Getting Started

### Prerequisites

- Node.js 22.21.1 (`nvm use` reads the committed `.nvmrc`)
- npm 10.9.4 (declared by `packageManager`)

### Installation

```bash
# Install exactly the locked dependencies
npm ci

# Initialize isolated Cloudflare development storage and local secrets file
npm run setup:dev

# Fill GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.development.local
# Google callback: http://localhost:3100/api/auth/callback/google
npm run check:dev

# Run cloud-mode development with Google sign-in
npm run dev

# Open http://localhost:3100
```

The default development command uses the cloud API handlers with Google sign-in,
isolated local D1/R2 storage, and an empty workspace after your first login. It does
not connect to production data or seed demo contacts. Setup keeps credentials in
the ignored, owner-only `.env.development.local` file and applies all D1 migrations
locally. Missing credentials stop startup instead of falling back to SQLite.

See [the development guide](docs/development.md) for Google OAuth setup, the local
Workers preview, runtime differences, and verification commands.

For the separate single-user SQLite version, explicitly run `npm run dev:local`.
It uses `data/relationships.db`, preserves existing data, and disables automatic
demo seeding. It does not exercise the cloud login or D1/R2 handlers.

Production databases start empty. In a direct SQLite installation, set
`SEED_DEMO_DATA=true` to explicitly seed an empty database. Once a
database has contained contacts, deleting them all will not cause demo contacts to
reappear on restart.

### Recommended Production Install

Docker Compose provides the reproducible production path. It runs Bonds as a
non-root user with a read-only application filesystem, binds the service to localhost,
and keeps the database and verified backups in a persistent named volume. Both build
stages use the same exact Node release pinned to its official multi-platform image
digest; CI actions are also pinned to immutable upstream commits.

```bash
# Create a local deployment configuration that Git will ignore
cp .env.container.example .env

# Generate a signing secret, then put it and a unique 12+ character password in .env
openssl rand -base64 32

# Build and start Bonds
docker compose up --detach --build

# Confirm the service is healthy
docker compose ps
```

Open `http://localhost:3100`. The Compose file deliberately does not publish Bonds
to the wider network. Use an authenticated HTTPS tunnel or reverse proxy from the
remote-access section when access from another device is required.

The `bonds-data` volume contains both `/data/relationships.db` and `/data/backups`.
The container initializes `/data` as owner-only and the app enforces `0600` files and
`0700` data directories at startup. Existing bind mounts must be owned by the container
user (`node`, UID 1000) so Bonds can apply those protections.
Do not run `docker compose down --volumes` unless the intent is to permanently delete
that local data.

### Manual Production Build

```bash
npm ci
npm run build
CRM_PASSWORD=replace-with-a-strong-password \
CRM_SESSION_SECRET=replace-with-at-least-32-random-characters \
CRM_DATABASE_PATH=data/relationships.db \
node .next/standalone/server.js
```

The build always uses a disposable SQLite database and rejects standalone output
containing database or environment files. The generated folder includes its static
assets and traced native dependencies, so it can be deployed without development
packages.

Health probes are public, privacy-safe, and read-only:

- `GET /api/health/live` returns `200` when the Node process can answer. Use it only
  for liveness checks that decide whether a process should be restarted.
- `GET /api/health/ready` returns `200` when authentication, database access, and the
  current schema are ready to serve requests. `/api/health` remains a compatible alias.
- Backup protection is reported as `current`, `due`, `failed`, or `disabled`. A due or
  failed backup changes the response status to `degraded` but remains HTTP `200`,
  preventing a backup-directory problem from causing a container restart loop. Alert
  on degraded responses instead.

Probes never create backups, run `VACUUM`, or mutate the database or filesystem. The
production container uses the readiness endpoint. SQLite integrity is checked during
startup and around backup and restore operations rather than on every public probe.

### Authentication

Local development remains open when authentication variables are unset. Production
fails closed and returns `503` until a strong account password and signing secret are
configured:

```bash
CRM_PASSWORD=replace-with-a-password-of-at-least-12-characters
CRM_SESSION_SECRET=replace-with-at-least-32-random-characters
CRM_SESSION_TTL_HOURS=168
CRM_API_TOKEN=optional-token-of-at-least-32-random-characters
```

Web sessions are randomized, signed, HTTP-only, same-site cookies that expire after
seven days by default. Set `CRM_SESSION_TTL_HOURS` to a whole number from `1` to `168`
to shorten that lifetime; invalid values fail closed. Session signatures are bound to
both the account password and signing secret, so rotating either value immediately
revokes every existing browser session. Cookies receive the `Secure` attribute on
direct HTTPS or when a trusted proxy reports HTTPS; loopback HTTP remains usable for
local-only installs. Never expose an HTTP deployment beyond the local machine.
`CRM_API_TOKEN` is optional and is intentionally limited to the LinkedIn import
endpoint used by trusted integrations such as the Chrome extension. It cannot access
contacts, backups, or other account APIs. Never reuse the account password as an API token. Copy
`.env.example` to `.env.local` for the complete configuration surface.
Scoped bearer imports are durably limited to 30 requests per minute and 500 per day
across all app workers. Bulk transfers should use the signed-in vCard or CSV workflows.
The app's own public origin is allowed automatically, including behind a reverse
proxy. `CORS_ALLOWED_ORIGINS` is only needed for additional cross-origin clients.
Every route also sends an explicit no-index policy, and `/robots.txt` disallows the
entire installation. This is defense in depth for private tunnel hostnames, not a
replacement for authentication or access controls.

Login attempts are stored atomically in SQLite so throttling survives restarts and
multiple app workers. A client receives five attempts per 15 minutes, while an
account-wide ceiling of 20 attempts per minute limits attackers rotating addresses.
Only hashes of client identities are stored. A successful login clears the counters.

Request bodies are consumed through streaming size guards before parsing. Ordinary
JSON mutations are limited to 256 KB, sign-in payloads to 4 KB, and LinkedIn imports
to 64 KB. CSV and vCard uploads use the configured contact-import file limit with a
separate bounded allowance for multipart framing, so chunked requests cannot bypass
the memory ceiling.

Signed-in `POST` requests that create contacts, interactions, reminders, or plans
require an `Idempotency-Key` header containing a random UUID. Repeating the same
normalized request with that key for up to seven days returns the original record and
sets `Idempotency-Replayed: true`; reusing the key with changed input fails with `409`.
The Bonds forms manage these keys automatically. Additional CORS origins may send the
request header and inspect the replay response header. The private ledger stores only
request hashes and numeric record IDs, is capped at 5,000 entries, participates in
verified backups, and is removed by permanent workspace erasure.

Every HTML navigation receives a fresh nonce-based Content Security Policy. Production
pages execute only framework scripts carrying that nonce, reject inline script
attributes, framing, plugins, foreign form targets, foreign API connections, and remote
contact images. Contact photos selected from the device are cropped, resized, stripped
of metadata, and embedded in the local database. People lists return a small projection;
embedded photos load lazily through an authenticated, no-store, same-origin endpoint rather
than being repeated inside the directory JSON. Pages are rendered per request so Next.js
can attach the nonce to its runtime; API and install-asset requests avoid that overhead.

Every response also receives a server-generated `X-Request-ID`; incoming values are
overwritten so clients cannot forge log correlation. Server events are emitted as
single-line JSON with only allowlisted operational fields. Contact data, request bodies,
query strings, filenames, error messages, and stack traces are never included. Set
`CRM_LOG_LEVEL` to `info`, `warn`, `error`, or `silent` (`info` in the production
container), and inspect local deployments with `docker compose logs bonds`.

Forwarded client, host, and protocol headers are ignored by default. Set
`CRM_TRUST_PROXY_HEADERS=true` only when Bonds is unreachable directly and the trusted
proxy overwrites incoming `CF-Connecting-IP`, `X-Real-IP`, `X-Forwarded-For`,
`X-Forwarded-Host`, and `X-Forwarded-Proto` values. This enables per-client throttling,
public-origin reconstruction, and HSTS behind that proxy without trusting spoofed
headers from direct clients.

## Remote Access

Configure authentication before exposing Bonds through any tunnel or public URL.
When the tunnel is the only path to the localhost-bound service and it overwrites
forwarded headers, enable `CRM_TRUST_PROXY_HEADERS=true` in the deployment environment.

### Install & Offline Safety

On localhost or HTTPS, supported browsers can install Bonds from the browser menu as a
standalone app. The service worker caches only the manifest, icons, stylesheet, and a
static offline explanation. Contacts, authenticated pages, APIs, exports, and backups
always remain network-only and are never written to browser Cache Storage. If the Bonds
server or tunnel is unreachable, navigation shows the offline explanation rather than
a browser error; relationship data remains on the server and is not available offline.

### Option 1: Cloudflare Tunnel (Free, Recommended)

```bash
# Install Cloudflare Tunnel
brew install cloudflared

# Login
cloudflared tunnel login

# Create tunnel
cloudflared tunnel create relationships

# Route domain
cloudflared tunnel route dns relationships relationships.yourdomain.com

# Run tunnel (in a separate terminal)
cloudflared tunnel run relationships --url http://localhost:3100
```

Now access from anywhere at `https://relationships.yourdomain.com`

### Option 2: Tailscale

```bash
# Install Tailscale
brew install tailscale

# Start Tailscale
tailscale up

# Access from any device on your Tailscale network
# using your machine's Tailscale IP + :3100
```

### Option 3: ngrok (Temporary Testing)

```bash
ngrok http 3100
```

## Usage

### Bringing Your Contacts In

1. Open **Contacts** and choose **Transfer contacts**
2. Select a `.vcf` vCard file from Apple Contacts, Google Contacts, Outlook, or your phone, or select a `.csv` file
3. Review the imported, duplicate, and invalid-record totals

Bonds matches duplicates by email, normalized phone number, or name and birthday.
Importing the same file again is safe. vCard is the recommended format when moving
between contact apps because it preserves more contact details.

### Adding Contacts

1. Click "Add Contact" button
2. Fill in basic info (name required)
3. Add tags like "friend", "running", "tech"
4. Set contact frequency (how often you want to stay in touch)
5. Add gift ideas for easy reference

### Cleaning Up Duplicates

1. Open **Contacts** and choose **Clean up**
2. Review matches based on email, normalized phone number, or name and birthday
3. Choose the profile whose name and core details should remain
4. Merge the profiles; notes, tags, alternate addresses, interactions, reminders,
   plans, facts, and group memberships are combined automatically

Each merge runs in a single database transaction and creates a verified **Before
duplicate merge** recovery point first. Alternate email addresses and phone numbers
remain available in vCard exports.

### Logging Interactions

1. Go to any contact detail page
2. Click "Log moment" in the profile header
3. Select type (call, message, meetup, email)
4. Add summary and notes
5. Contact's "last contacted" date updates automatically

### Check-in Rhythm

Contact cards show timing against the check-in interval you choose: not tracking yet,
on your rhythm, due soon, or ready to reconnect. With no logged conversation,
the status is unknown rather than a perfect score. This is a reminder preference,
not a measure of how close or healthy a relationship is.

## Browser Extension Testing

If you want to test a Chrome extension that imports LinkedIn contacts into the CRM:

1. Create `.env.local` with your extension ID:

```bash
CORS_ALLOWED_EXTENSION_IDS=ogodllnlbnmkhmaccmnoepajfapennja
CRM_API_TOKEN=replace-with-at-least-32-random-characters
```

2. Restart the app with `npm run dev`
3. Save the CRM URL and API token in the extension popup
4. Have the extension `POST` to `http://localhost:3100/api/import/linkedin`

For the unpacked extension in this repo, load [browser-extension/README.md](browser-extension/README.md) and use the bundled stable extension ID above.

Example payload:

```json
{
  "fullName": "Ada Lovelace",
  "headline": "Staff Engineer at Analytical Engines",
  "company": "Analytical Engines",
  "location": "London",
  "linkedinUrl": "https://www.linkedin.com/in/ada-lovelace/",
  "photoUrl": "https://example.com/ada.jpg",
  "tags": ["linkedin", "engineering"],
  "notes": "Imported from LinkedIn profile"
}
```

The endpoint will:
- map the payload into a CRM contact
- tag the contact with `linkedin`
- store LinkedIn metadata in `custom_fields`
- skip creating a duplicate if the email or LinkedIn profile URL already exists

## Database & Recovery

Data is stored in `data/relationships.db` by default. Open **Settings → Data &
recovery** to create, encrypt, restore, or remove backups.

Backups use SQLite's atomic snapshot operation, run integrity and schema checks, and
include a SHA-256 manifest. Bonds keeps up to 20 snapshots by default, preserving the
newest manual, automatic, pre-restore, pre-merge, and pre-delete checkpoint before
filling remaining slots with the newest snapshots overall. Before every restore,
duplicate merge, or contact deletion, it creates a separate recovery
point containing the current state. Individual and bulk contact deletes fail closed
if that snapshot cannot be verified, and bulk deletion is limited to 100 contacts per
request. Recovery points can be restored from **Settings → Data & recovery**.

```bash
CRM_DATABASE_PATH=data/relationships.db
CRM_BACKUP_DIRECTORY=data/backups
CRM_BACKUP_RETENTION_COUNT=20
CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS=24
CRM_MAX_RESTORE_MB=256
CRM_MAX_CONTACT_IMPORT_MB=10
```

Paths may be absolute or relative to the app directory and must point into dedicated
data subdirectories; filesystem roots, the operating-system temp root, the user home,
and the application root are rejected rather than having their permissions changed.
Local snapshots protect
against bad edits and restores but not loss of the host device. For disaster recovery,
enter a unique passphrase in Settings and download a `.bonds` copy to a separate disk
or storage provider. Encryption and decryption happen entirely in the browser using
PBKDF2-HMAC-SHA-256 and AES-256-GCM; the passphrase is never sent to Bonds or stored.
There is no passphrase recovery, so keep it separately from the encrypted file.

At startup, Bonds removes group and world access from the database directory, SQLite
database, WAL/SHM files, backup directory, managed snapshots, manifests, and maintenance
files. Data directories use mode `0700` and private files use `0600`; startup and
recovery operations fail closed if the app user cannot enforce those permissions.

Encrypted restores are decrypted in browser memory, then sent through the same size,
SQLite integrity, schema compatibility, and pre-restore recovery checks as local
snapshots. Compatible raw `.db` files remain accepted for migration and emergency
recovery, but encrypted `.bonds` files are the recommended off-device format.

Cloudflare mode uses private R2 recovery points instead of the local SQLite directory.
Scheduled cloud snapshots are implemented but disabled until migration, deployment,
and a live restore drill; see [cloud automatic backups](docs/cloud-automatic-backups.md)
for the activation gate and 16 MB coverage limit.
An owner-only Advanced recovery workflow for larger private cloud snapshots is also
implemented behind `CLOUD_LARGE_RECOVERY_ENABLED=false`. It is not deployed or
validated against live Cloudflare quotas. Its background apply/rollback path requires
two Cloudflare Queues and migration 0023; keep it disabled until the checks in
[large-workspace recovery design](docs/cloud-large-recovery-design.md) are complete.

**Settings → Data & recovery → Permanently erase Bonds** provides a typed-confirmation
wipe for the active installation. It removes contacts and all related history,
workspace and integration records, login-throttle identifiers, restore staging files,
and every Bonds-managed snapshot and manifest. It then truncates SQLite's WAL and
compacts deleted pages before recreating only an empty local workspace. The deployment
password and environment configuration remain unchanged. Downloaded `.bonds` files,
host-level snapshots, and storage-device forensic copies are outside the app's control
and must be removed separately.

Production creates an atomic, integrity-checked snapshot immediately when protection
is due and then every 24 hours by default. A cross-process lock prevents duplicate
snapshots and keeps backup, restore, merge, and erasure operations from overlapping
when multiple workers serve the app. Ordinary writes queue behind one another, while
new writes fail with `409` as soon as restore, erasure, or another maintenance task
owns the database boundary; this prevents a waiting request from repopulating data
after maintenance finishes. Set
`CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS` from `1` to `8760` to change the cadence, or
`0` to disable it intentionally. Automatic, manual, and pre-change snapshots share
the configured retention limit.

At startup, Bonds migrates known legacy schemas transactionally, verifies required
columns, rejects databases from newer incompatible versions, and runs SQLite in WAL
mode with foreign-key checks and a lock timeout. This keeps normal reads responsive
while writes, builds, or backup operations overlap.

vCard and CSV imports are limited to 10 MB and 25,000 contacts per request by
default, reuse the same field validation as manual entry, and report malformed
records without discarding valid contacts. CSV exports neutralize formula-like cells
before spreadsheet applications can evaluate them. CSV and vCard downloads stream
contacts directly from SQLite with backpressure, so export memory stays bounded even
when the address book or embedded contact photos are large. Change the shared upload
limit with `CRM_MAX_CONTACT_IMPORT_MB`; the previous `CRM_MAX_CSV_IMPORT_MB` name
remains a backward-compatible fallback.

Large address books are browsed in stable server-side pages of 50 contacts; API clients
may request up to 100 with `pageSize`. Search covers names, email addresses, phone
numbers, notes, and imported context without sending the full address book to the
browser, and tag filters use exact JSON membership rather than substring matching.
Mention suggestions return at most 20 minimal identity records and deliberately omit
notes, tags, custom fields, and embedded photos. The Groups screen loads tag summaries
first, then fetches members and searchable available contacts in pages of 30. Adding
people to a tag group is one transactional request capped at 100 contacts rather than
one network mutation per person. Tag writes are case-insensitively unique, limited to
100 tags per contact and 100 characters per tag, and reject stale bulk selections
without partially changing the remaining contacts.

Pending reminders use the same stable paging model with 50 items per page and a
100-item API maximum. Browser alert polling receives only minimal `id` and due-time
records for the newest due reminders, capped to the local 2,000-entry notification
ledger; future reminders, contact names, titles, and notes never enter that payload.
Browser alert choices and ledgers are scoped to the verified account, so switching
accounts in the same browser does not inherit the previous account's setting or
suppress its alerts. Older unscoped browser preferences are not migrated; users
must opt in again.
New reminder times are normalized to UTC, while indexed instant-based queries preserve
correct ordering for legacy timestamps that include explicit time-zone offsets.

Cloud accounts also have an opt-in email path for explicit due reminders and contact
birthday alerts. It is
disabled in `wrangler.jsonc` until the sender domain and Email Sending binding are
verified; the Reminders page reports that state honestly. See
[`docs/cloud-email-reminders.md`](docs/cloud-email-reminders.md) for activation and
delivery limitations. Browser alerts still require the app to be open.

Contact detail pages also use independent history windows: 30 interactions and timeline
items, three open reminders, four structured facts, and 20 open plans are loaded for
the first paint. Exact totals remain visible and each section can progressively load
older pages up to the 100-item API maximum. Relationship briefs use aggregate activity
counts, the latest interaction, and the nearest reminder rather than mistaking a
truncated page for the full relationship history.

General plan reads and legacy numeric-group endpoints return stable pages of 50 items
with a 100-item API maximum. Contact-scoped plan reads continue to include completed
plans by default, while the global plan feed continues to show open plans by default.
These compatibility limits do not change the consumer-facing tag Groups experience.

Duplicate review scans a minimal identity projection across the address book, then
hydrates only the 10 visible match groups. Review pages are capped at 25 groups, and
clusters larger than 21 profiles are presented as repeatable recovery-backed batches
that always include the recommended primary profile. Unique contacts never contribute
their notes, photos, or other large fields to the duplicate-review response.

Dashboard intelligence reads only the contact fields it needs. SQLite reduces each
contact's interaction history to a count and latest interaction before data reaches
the application, and only the four nearest open reminders are loaded for the daily
feed while the full open-reminder total remains accurate. This keeps smart-list and
dashboard payload work linear without exposing contact notes or photos.

### Upgrading A Container Install

1. Create a verified backup from **Settings → Data & recovery**
2. Download an encrypted `.bonds` copy and store it away from the host running Bonds
3. Update the source, then run `docker compose build --pull`
4. Run `docker compose up --detach --remove-orphans`
5. Confirm `docker compose ps` reports the container as healthy

Schema migrations run transactionally when the new container starts. If an upgrade
must be rolled back, deploy the previous image and restore the pre-upgrade backup from
Settings rather than manipulating SQLite files while Bonds is running.

## Customization

### Changing Port

Edit `package.json`:

```json
"dev": "next dev -p 3200",
"start": "next start -p 3200"
```

### Database Path

Set `CRM_DATABASE_PATH` and `CRM_BACKUP_DIRECTORY` to move live data and recovery
snapshots without changing source code.

## Privacy

- **100% local** - No cloud sync, no telemetry
- **Your data stays on your machine**
- SQLite database is just a file you control
- Database and managed recovery files are readable only by the app’s operating-system user
- Production access requires a signed session or dedicated API token
- Integration API tokens cannot access account data or recovery endpoints

## Development

```bash
# Install dependencies
npm ci

# Run dev server with hot reload
npm run dev

# Build for production
npm run build

# Start production server
npm start

# Exercise the optimized server's critical signed-in journey (requires a build)
npm run test:production

# Install the pinned Chromium build once, then run desktop and mobile browser journeys
npx playwright install chromium
npm run test:e2e

# Type check
npm run lint

# Validate the isolated iOS app and produce its Metro bundle
npm ci --prefix apps/mobile
npm run test:mobile
```

The repository CI workflow runs dependency installation, unit tests, lint, the npm
security audit, a production build, an isolated standalone-server journey, desktop and
mobile Chromium journeys, Compose validation, and a container health smoke test on
every push and pull request. Browser traces, screenshots, and video are retained in the
Playwright report when a journey fails. E2E servers always use disposable SQLite and
backup directories; they never open the development or production workspace. The
browser gate also runs WCAG 2.x A/AA axe audits over login and every primary signed-in
route at both responsive breakpoints. It additionally proves encrypted `.bonds`
downloads can restore an earlier workspace state through the complete Settings UI on
desktop and mobile.

## Project Structure

```
├── app/
│   ├── page.tsx              # Dashboard
│   ├── contacts/
│   │   ├── page.tsx         # Contact list
│   │   ├── new/page.tsx     # Add contact form
│   │   └── [id]/
│   │       ├── page.tsx     # Contact detail
│   │       └── edit/page.tsx # Edit contact form
│   ├── api/
│   │   ├── contacts/        # CRUD endpoints
│   │   ├── interactions/    # Log interactions
│   │   └── stats/           # Dashboard stats
│   └── layout.tsx           # Root layout
├── components/ui/           # Reusable UI components
├── lib/
│   ├── db.ts               # SQLite client + schema
│   └── utils.ts            # Helper functions
└── data/
    └── relationships.db    # SQLite database
```

## Troubleshooting

### Database Locked Error

If you see "database is locked", close all terminals/processes running the app.

### Port Already in Use

Change the port in `package.json` or kill the process using port 3100:

```bash
lsof -ti:3100 | xargs kill
```

### Missing Dependencies

```bash
npm ci
```

## Contributing

This is a personal project, but feel free to fork and customize for your needs!

## License

MIT

## Author

Built by Legolas (OpenClaw agent) for Miguel Amaral
