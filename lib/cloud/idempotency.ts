import { fingerprintIdempotencyInput, IdempotencyError, requireIdempotencyKey } from '@/lib/idempotency';

type CreateTable = 'contacts' | 'interactions' | 'reminders' | 'plans' | 'contact_children' | 'contact_relationships';
type FieldValue = string | number | null;

/** The ledger and resource commit together. A retry never re-runs the insert. */
export async function createCloudResource<T extends { id: number }>(
  db: CloudflareEnv['DB'],
  request: Request,
  workspaceId: string,
  table: CreateTable,
  fields: Record<string, FieldValue>,
) {
  const key = requireIdempotencyKey(request.headers);
  const fingerprint = fingerprintIdempotencyInput(fields);
  const owner = crypto.randomUUID();
  const columns = Object.keys(fields);
  if (columns.some((column) => !/^[a-z_]+$/.test(column) || column === 'workspace_id' || column === 'id')) {
    throw new Error('Invalid internal create fields.');
  }

  // batch() is a D1 transaction. The random owner identifies the one caller that
  // inserted the ledger entry, including when two first attempts arrive together.
  const results = await db.batch([
    db.prepare(`INSERT INTO mutation_receipts (workspace_id, scope, request_key, fingerprint, owner_token)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, scope, request_key) DO NOTHING`)
      .bind(workspaceId, table, key, fingerprint, owner),
    db.prepare(`INSERT INTO ${table} (workspace_id, ${columns.join(', ')})
      SELECT ?, ${columns.map(() => '?').join(', ')}
      WHERE EXISTS (SELECT 1 FROM mutation_receipts
        WHERE workspace_id = ? AND scope = ? AND request_key = ? AND owner_token = ? AND resource_id IS NULL)`)
      .bind(workspaceId, ...Object.values(fields), workspaceId, table, key, owner),
    db.prepare(`UPDATE mutation_receipts SET resource_id = last_insert_rowid()
      WHERE workspace_id = ? AND scope = ? AND request_key = ? AND owner_token = ? AND resource_id IS NULL`)
      .bind(workspaceId, table, key, owner),
    db.prepare('SELECT fingerprint, owner_token FROM mutation_receipts WHERE workspace_id = ? AND scope = ? AND request_key = ?')
      .bind(workspaceId, table, key),
    db.prepare(`SELECT resource.* FROM ${table} resource JOIN mutation_receipts receipt
      ON resource.workspace_id = receipt.workspace_id AND resource.id = receipt.resource_id
      WHERE receipt.workspace_id = ? AND receipt.scope = ? AND receipt.request_key = ?`)
      .bind(workspaceId, table, key),
  ]);
  const receipt = results[3].results[0] as { fingerprint: string; owner_token: string } | undefined;
  if (!receipt) throw new Error('Create receipt was not persisted.');
  if (receipt.fingerprint !== fingerprint) {
    throw new IdempotencyError('This Idempotency-Key was already used for a different create request.', 409);
  }
  const resource = results[4].results[0] as T | undefined;
  if (!resource) {
    throw new IdempotencyError('The original create result is no longer available. Start a new request.', 409);
  }
  return { resource, replayed: receipt.owner_token !== owner };
}
