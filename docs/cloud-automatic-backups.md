# Cloud Automatic Backups

The Cloudflare Worker can make verified per-workspace CRM snapshots on a 24-hour interval. It reuses the managed JSON recovery format and private R2 bucket, not the local SQLite backup directory. Each 15-minute Cron pass leases at most two due workspaces, creates and verifies their snapshots, releases pins, and applies the existing retention policy. Failed storage attempts retry after 30 minutes; a workspace over the 16 MB interactive limit is marked uncovered and retried the next day. Abandoned pins and incomplete backup objects older than one hour are cleaned up separately in bounded batches.

Settings checks that a `current` schedule still has a listed automatic R2 object with a checksum manifest. It shows a failure rather than a green state if that object is missing. This is not a continuous rehash of stored bytes; checksum verification happens when the snapshot is written and again before a managed restore.

`CLOUD_AUTOMATIC_BACKUP_ENABLED` remains `false` in `wrangler.jsonc`. Do not switch it on merely because the build passes.

## Activation Gate

1. Inspect the remote D1 migration state and back up the current deployment. Apply all pending migrations through `0012_nebulous_bedlam.sql` before deploying code that reads `cloud_backup_schedules` or `cloud_backup_files.created_at`.
2. Deploy with the flag still off. Confirm authenticated Data & recovery reads, manual create/download/restore, erasure behavior, and Cron cleanup logs on a controlled workspace.
3. Enable the flag for a controlled deployment. Confirm a Cron-created `automatic` snapshot, checksum-verified R2 file, a `current` Settings state, a failed-provider retry, and a restore drill that returns the schedule to `due`.
4. Watch due/failed/oversized states and oldest scheduled lag. The current cap is two attempts every 15 minutes (at most 192 per day if every run succeeds), so add a scalable queue or workflow before claiming daily coverage for a larger population.

Large workspaces still need resumable, streaming snapshot and restore jobs; 16 MB is a hard current limit. Managed R2 snapshots are not end-to-end encrypted with a user passphrase. The optional encrypted `.bonds` download is the off-service copy. A green local or workerd test does not verify live Cron delivery, remote quotas, OAuth, or R2 durability.

The backup publisher rechecks the workspace revision and operation pin after R2 upload before marking the file ready. A concurrent CRM edit invalidates that attempt; scheduled backup status stays uncovered and retries. Direct downloads reject non-ready files and verify the stored SHA-256 checksum before serving bytes. These checks protect the existing bounded format, not the still-unbuilt large-workspace recovery path described in `docs/cloud-large-recovery-design.md`.
