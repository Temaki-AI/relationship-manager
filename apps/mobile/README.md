# Bonds Mobile

The native, offline-first companion to Bonds. This package is intentionally isolated
from the Next.js server and uses its own lockfile so mobile SDK upgrades cannot change
the production web runtime.

## Development

```bash
npm ci
npm start
```

Use Expo Go for the quickest device loop. A local native build requires full Xcode:

```bash
npm run ios
npm run validate
```

The first release stores contacts, interactions, reminders, and a future sync queue in
an on-device SQLite database. Local notifications are scheduled by iOS, so reminders
can fire while Bonds is closed. Choosing a person uses the system contact picker rather
than reading the entire address book.

## Current Boundary

- Mobile data does not sync to the web server yet.
- The database is protected by the iOS application sandbox and device data protection;
  SQLCipher and recovery exports are planned before public release.
- `remote_id` columns and a durable outbox reserve the sync boundary without making the
  offline experience depend on a server.
- Generated `ios` and `android` projects remain uncommitted; Expo configuration is the
  source of truth.

See [docs/architecture.md](docs/architecture.md) for the decisions behind this boundary.
