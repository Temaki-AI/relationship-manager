export const EXPORT_PART_BYTES = 5 * 1024 * 1024;
export const MAX_EXPORT_BATCH_BYTES = 8 * 1024 * 1024;

export type ExportPart = { partNumber: number; etag: string };

type ExportStore = {
  get(key: string): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(key: string, value: Uint8Array): Promise<unknown>;
  resumeMultipartUpload(key: string, uploadId: string): {
    uploadPart(partNumber: number, value: Uint8Array): Promise<ExportPart>;
    complete(parts: ExportPart[]): Promise<unknown>;
  };
};

async function readScratch(store: ExportStore, key: string | null, expectedSize: number): Promise<Uint8Array> {
  if (!key) {
    if (expectedSize !== 0) throw new Error('Export scratch state is incomplete.');
    return new Uint8Array();
  }
  const object = await store.get(key);
  if (!object || object.size !== expectedSize) throw new Error('Export scratch data is unavailable.');
  return new Uint8Array(await object.arrayBuffer());
}

export async function appendExportBatch(
  store: ExportStore,
  options: {
    key: string;
    uploadId: string;
    parts: ExportPart[];
    scratchKey: string | null;
    scratchSize: number;
    nextScratchKey: string;
    bytes: Uint8Array;
  }
): Promise<{ parts: ExportPart[]; scratchSize: number }> {
  if (options.bytes.byteLength > MAX_EXPORT_BATCH_BYTES) throw new Error('Export batch is too large.');
  if (options.scratchSize < 0 || options.scratchSize >= EXPORT_PART_BYTES) throw new Error('Invalid export scratch size.');
  const previous = await readScratch(store, options.scratchKey, options.scratchSize);
  const combined = new Uint8Array(previous.byteLength + options.bytes.byteLength);
  combined.set(previous);
  combined.set(options.bytes, previous.byteLength);
  const upload = store.resumeMultipartUpload(options.key, options.uploadId);
  const parts = [...options.parts];
  let offset = 0;
  while (combined.byteLength - offset >= EXPORT_PART_BYTES) {
    const partNumber = parts.length + 1;
    const part = await upload.uploadPart(partNumber, combined.subarray(offset, offset + EXPORT_PART_BYTES));
    parts.push(part);
    offset += EXPORT_PART_BYTES;
  }
  const remainder = combined.slice(offset);
  if (remainder.byteLength) await store.put(options.nextScratchKey, remainder);
  return { parts, scratchSize: remainder.byteLength };
}

export async function completeExportUpload(
  store: ExportStore,
  options: { key: string; uploadId: string; parts: ExportPart[]; scratchKey: string | null; scratchSize: number }
): Promise<void> {
  const upload = store.resumeMultipartUpload(options.key, options.uploadId);
  const parts = [...options.parts];
  const remainder = await readScratch(store, options.scratchKey, options.scratchSize);
  if (remainder.byteLength) parts.push(await upload.uploadPart(parts.length + 1, remainder));
  if (!parts.length) throw new Error('Empty contact exports are not supported by multipart completion.');
  await upload.complete(parts);
}
