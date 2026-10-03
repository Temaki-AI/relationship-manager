# Mobile Architecture

## Product Boundary

Bonds Mobile is offline-first. Core relationship capture must work without a network,
an account, or a running Bonds server. The existing Next.js application remains the
web product and future sync service rather than being embedded in a web view.

## Data Identity

Mobile entities use UUIDv4 text primary keys. A nullable `remote_id` maps an entity to
the current server's integer identifier after sync is introduced. Tombstones and a
durable `sync_queue` make offline deletion and retryable upload possible without
rewriting local identifiers.

## Storage

Expo SQLite owns one device-local database. Migrations are monotonic, transactional,
and guarded by SQLite's `user_version`. Foreign keys, WAL mode, and a busy timeout are
enabled at initialization. User input is always bound through parameterized queries.

## Native Capabilities

- The system contact picker imports one explicitly selected person.
- iOS schedules local reminder notifications and remains responsible for delivery.
- SecureStore and LocalAuthentication are installed for the device-lock milestone.
- No analytics, advertising SDK, remote image loader, or third-party data service is
  included.

## Sync Contract

Sync is deliberately deferred until the server supports device-scoped credentials,
versioned payload schemas, per-workspace ownership, tombstones, and conflict handling.
The local outbox records intent but no background uploader ships before those controls.
