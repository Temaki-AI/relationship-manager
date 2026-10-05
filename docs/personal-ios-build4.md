# Everclose personal iOS build 4 — 5 October 2026

Build 4 adds startup recovery. Failed database initialization, locked phone
identity storage, or account-cache selection now show an accessible retry screen
instead of leaving the native splash visible. Retry opens the same account cache;
it does not reset files, credentials, drafts or queued edits. Failed initialization
releases its SQLite handle. Late account-cache replies cannot expose another
account or replace its current startup result.

Native TypeScript, lint, five native package tests and the production iOS/Hermes
export pass. Six focused startup tests cover retry, account-switch races, locked
identity storage, newer schemas, ownership failures and preservation of saved
contacts/outbox entries. Root TypeScript and lint for the changed tests pass.
The full iOS behavior suite and fresh device/simulator builds are in progress.

Build 3 remains the installed release until build 4 passes native linkage and
isolated first-launch verification and is signed with the existing local profile.
Physical account/data, photo, Calendar and closed-app reminder journeys still
require phone verification. This is the personal development release; public
distribution and the remaining provider integrations are tracked separately.

The unrelated Gmail metadata-download work in the local checkout is unfinished
and is not part of this iOS release. No cloud deployment or production database
migration is included.
