import { backupChecksum } from '@/lib/cloud/recovery-storage';
import { CloudRecoveryError, SNAPSHOT_TABLES, validateSnapshotRows, type SnapshotRow, type SnapshotTable } from '@/lib/cloud/recovery-contract';
import { CAPTURE_PAGE_ROWS, MAX_CAPTURE_CHUNK_BYTES, snapshotChunkKey, snapshotCursor } from '@/lib/cloud/snapshot-capture';
import { parseTodaySnoozeTarget } from '@/lib/today-snooze';

type Assets = CloudflareEnv['PRIVATE_ASSETS'];
const decoder = new TextDecoder('utf-8', { fatal: true });
const hashPattern = /^[a-f0-9]{64}$/u;

export const MANIFEST_PART_CHUNKS = 8;
export type SnapshotArtifactIdentity = { workspaceId: string; jobId: string; revision: number };
export type SnapshotChunkDescriptor = {
  sequence: number;
  table_name: SnapshotTable;
  cursor_key: string;
  row_count: number;
  byte_length: number;
  sha256: string;
};
export type SnapshotReadCursor = { tableIndex: number; cursorKey: string };
export type PrivateSnapshotRoot = SnapshotArtifactIdentity & {
  format: 'everclose-cloud-manifest';
  version: 1;
  snapshotSchemaVersion: 4;
  createdAt: string;
  workspace: { name: string; persona: string | null };
  tableOrder: SnapshotTable[];
  rowCounts: Record<SnapshotTable, number>;
  chunkCount: number;
  partCount: number;
  partsChainSha256: string;
};

export class SnapshotArtifactError extends CloudRecoveryError {
  constructor(message: string) { super(message, 409); }
}
function invalid(message: string): never { throw new SnapshotArtifactError(message); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function natural(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function parseBytes(bytes: Uint8Array, label: string): unknown {
  try { return JSON.parse(decoder.decode(bytes)); }
  catch { return invalid(`${label} is not valid JSON.`); }
}

export function snapshotManifestPartKey(workspaceId: string, jobId: string, index: number) {
  return `${workspaceId}/recovery-jobs/${jobId}/manifest-parts/${index}.json`;
}

export function snapshotManifestKey(workspaceId: string, jobId: string, sha256: string) {
  return `${workspaceId}/recovery-jobs/${jobId}/manifest-${sha256}.json`;
}

export async function readPrivateSnapshotRoot(identity: Pick<SnapshotArtifactIdentity, 'workspaceId' | 'jobId'>,
  expectedSha256: string, assets: Assets): Promise<PrivateSnapshotRoot> {
  if (!hashPattern.test(expectedSha256)) return invalid('Snapshot manifest hash is invalid.');
  const object = await assets.get(snapshotManifestKey(identity.workspaceId, identity.jobId, expectedSha256));
  if (!object || object.size < 1 || object.size > 32_000 || object.customMetadata?.sha256 !== expectedSha256
    || object.customMetadata?.workspaceId !== identity.workspaceId || object.customMetadata?.jobId !== identity.jobId) {
    return invalid('Snapshot manifest is missing or has changed.');
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== object.size || await backupChecksum(bytes) !== expectedSha256) {
    return invalid('Snapshot manifest checksum does not match.');
  }
  const value = parseBytes(bytes, 'Snapshot manifest');
  if (!record(value) || value.format !== 'everclose-cloud-manifest' || value.version !== 1
    || value.snapshotSchemaVersion !== 4 || value.workspaceId !== identity.workspaceId || value.jobId !== identity.jobId
    || !natural(value.revision) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || !record(value.workspace) || typeof value.workspace.name !== 'string' || !value.workspace.name.trim()
    || value.workspace.name.length > 200 || value.workspace.persona !== null && typeof value.workspace.persona !== 'string') {
    return invalid('Snapshot manifest identity or schema is invalid.');
  }
  if (!Array.isArray(value.tableOrder) || value.tableOrder.length !== SNAPSHOT_TABLES.length
    || value.tableOrder.some((table, index) => table !== SNAPSHOT_TABLES[index]) || !record(value.rowCounts)
    || Object.keys(value.rowCounts).length !== SNAPSHOT_TABLES.length
    || SNAPSHOT_TABLES.some((table) => !natural((value.rowCounts as Record<string, unknown>)[table]))
    || !natural(value.chunkCount) || !natural(value.partCount)
    || value.partCount !== Math.ceil(value.chunkCount / MANIFEST_PART_CHUNKS)
    || value.partCount === 0 && value.partsChainSha256 !== ''
    || value.partCount > 0 && (typeof value.partsChainSha256 !== 'string' || !hashPattern.test(value.partsChainSha256))) {
    return invalid('Snapshot manifest counts or part chain are invalid.');
  }
  return value as PrivateSnapshotRoot;
}

export async function readPrivateSnapshotPart(root: PrivateSnapshotRoot, index: number, assets: Assets) {
  if (!natural(index) || index >= root.partCount) return invalid('Snapshot manifest part index is invalid.');
  const object = await assets.get(snapshotManifestPartKey(root.workspaceId, root.jobId, index));
  if (!object || object.size < 1 || object.size > 32_000
    || object.customMetadata?.workspaceId !== root.workspaceId || object.customMetadata?.jobId !== root.jobId
    || !hashPattern.test(object.customMetadata?.sha256 || '')) return invalid('Snapshot manifest part is missing or has changed.');
  const bytes = new Uint8Array(await object.arrayBuffer());
  const sha256 = await backupChecksum(bytes);
  if (bytes.byteLength !== object.size || sha256 !== object.customMetadata.sha256) {
    return invalid('Snapshot manifest part checksum does not match.');
  }
  const value = parseBytes(bytes, 'Snapshot manifest part');
  const expectedRows = Math.min(MANIFEST_PART_CHUNKS, root.chunkCount - index * MANIFEST_PART_CHUNKS);
  if (!record(value) || value.format !== 'everclose-cloud-manifest-part' || value.version !== 1
    || value.workspaceId !== root.workspaceId || value.jobId !== root.jobId || value.revision !== root.revision
    || value.index !== index || !Array.isArray(value.chunks) || value.chunks.length !== expectedRows) {
    return invalid('Snapshot manifest part identity or length is invalid.');
  }
  const chunks = value.chunks as unknown[];
  for (const [offset, descriptor] of chunks.entries()) {
    if (!record(descriptor) || descriptor.sequence !== index * MANIFEST_PART_CHUNKS + offset
      || !SNAPSHOT_TABLES.includes(descriptor.table_name as SnapshotTable) || typeof descriptor.cursor_key !== 'string'
      || !natural(descriptor.row_count) || descriptor.row_count < 1 || descriptor.row_count > CAPTURE_PAGE_ROWS
      || !natural(descriptor.byte_length) || descriptor.byte_length < 1
      || descriptor.byte_length > MAX_CAPTURE_CHUNK_BYTES + 1024
      || typeof descriptor.sha256 !== 'string' || !hashPattern.test(descriptor.sha256)) {
      return invalid('Snapshot manifest part contains invalid chunk descriptors.');
    }
  }
  return { sha256, chunks: chunks as SnapshotChunkDescriptor[] };
}

function compareCursor(table: SnapshotTable, left: string, right: string): number {
  if (table === 'contact_group_members') {
    try {
      const a = JSON.parse(left) as [number, number];
      const b = JSON.parse(right) as [number, number];
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 2 || b.length !== 2
        || !a.every(Number.isSafeInteger) || !b.every(Number.isSafeInteger)) return invalid('Snapshot cursor is malformed.');
      return a[0] - b[0] || a[1] - b[1];
    } catch { return invalid('Snapshot cursor is malformed.'); }
  }
  if (table === 'daily_snoozes') return left < right ? -1 : left > right ? 1 : 0;
  const a = Number(left);
  const b = Number(right);
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return invalid('Snapshot cursor is malformed.');
  return a - b;
}

export async function readPrivateSnapshotChunk(identity: SnapshotArtifactIdentity, chunk: SnapshotChunkDescriptor,
  previous: SnapshotReadCursor, assets: Assets): Promise<{ rows: SnapshotRow[]; next: SnapshotReadCursor }> {
  const tableIndex = SNAPSHOT_TABLES.indexOf(chunk.table_name);
  if (tableIndex < 0 || tableIndex < previous.tableIndex || !natural(chunk.sequence)
    || !natural(chunk.row_count) || chunk.row_count < 1 || chunk.row_count > CAPTURE_PAGE_ROWS
    || !natural(chunk.byte_length) || chunk.byte_length < 1 || chunk.byte_length > MAX_CAPTURE_CHUNK_BYTES + 1024
    || !hashPattern.test(chunk.sha256)) return invalid('Snapshot chunk descriptor is invalid.');
  const object = await assets.get(snapshotChunkKey(identity.workspaceId, identity.jobId, chunk.sequence, chunk.sha256));
  if (!object || object.size !== chunk.byte_length || object.customMetadata?.sha256 !== chunk.sha256
    || object.customMetadata?.workspaceId !== identity.workspaceId || object.customMetadata?.jobId !== identity.jobId
    || object.customMetadata?.table !== chunk.table_name) return invalid('Snapshot chunk is missing or has changed.');
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== object.size || await backupChecksum(bytes) !== chunk.sha256) {
    return invalid('Snapshot chunk checksum does not match.');
  }
  const value = parseBytes(bytes, 'Snapshot chunk');
  if (!record(value) || value.format !== 'everclose-cloud-chunk' || value.version !== 1
    || value.workspaceId !== identity.workspaceId || value.jobId !== identity.jobId || value.revision !== identity.revision
    || value.table !== chunk.table_name || value.sequence !== chunk.sequence) {
    return invalid('Snapshot chunk identity does not match.');
  }
  let rows: SnapshotRow[];
  try { rows = validateSnapshotRows(chunk.table_name, value.rows, identity.workspaceId, 4); }
  catch { return invalid('Snapshot chunk contains invalid CRM rows.'); }
  if (rows.length !== chunk.row_count) return invalid('Snapshot chunk row count does not match.');
  let cursor = previous.tableIndex === tableIndex ? previous.cursorKey : '';
  for (const row of rows) {
    const next = snapshotCursor(chunk.table_name, row);
    if (cursor && compareCursor(chunk.table_name, next, cursor) <= 0) return invalid('Snapshot chunk rows are out of order.');
    cursor = next;
    if (chunk.table_name === 'daily_snoozes') {
      const target = parseTodaySnoozeTarget(row.id);
      if (!target || (target.kind === 'reminder'
        ? row.reminder_id !== target.id
        : row.contact_id !== target.id || row.reminder_id !== null)) {
        return invalid('Snapshot contains an invalid snoozed prompt.');
      }
    }
  }
  if (cursor !== chunk.cursor_key) return invalid('Snapshot chunk cursor does not match.');
  return { rows, next: { tableIndex, cursorKey: cursor } };
}
