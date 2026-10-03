import assert from 'node:assert/strict';
import test from 'node:test';
import { appendExportBatch, completeExportUpload, EXPORT_PART_BYTES } from '../lib/cloud/export-assembly.ts';
import { createCloudHarness } from './helpers/cloud-harness.ts';

test('export assembly retries identical bytes with the latest part ETag and completes one large object', async () => {
  const h = await createCloudHarness();
  try {
    const key = 'test/exports/job/contacts.csv';
    const upload = await h.assets.createMultipartUpload(key);
    const first = new Uint8Array(EXPORT_PART_BYTES + 30);
    first.fill(65);
    const options = {
      key, uploadId: upload.uploadId, parts: [], scratchKey: null, scratchSize: 0,
      nextScratchKey: 'test/exports/job/scratch-1', bytes: first,
    };
    const initial = await appendExportBatch(h.assets, options);
    assert.equal(initial.parts.length, 1);
    assert.equal(initial.scratchSize, 30);
    const retried = await appendExportBatch(h.assets, options);
    assert.equal(retried.parts.length, 1);
    assert.equal(retried.parts[0].partNumber, 1);
    assert.equal(retried.scratchSize, initial.scratchSize);
    const tail = new TextEncoder().encode('END');
    const second = await appendExportBatch(h.assets, {
      ...options, parts: retried.parts, scratchKey: options.nextScratchKey,
      scratchSize: retried.scratchSize, nextScratchKey: 'test/exports/job/scratch-2', bytes: tail,
    });
    assert.equal(second.parts.length, 1);
    assert.equal(second.scratchSize, 33);
    await completeExportUpload(h.assets, {
      key, uploadId: upload.uploadId, parts: second.parts,
      scratchKey: 'test/exports/job/scratch-2', scratchSize: second.scratchSize,
    });
    const object = await h.assets.get(key);
    assert.equal(object?.size, first.byteLength + tail.byteLength);
    const bytes = new Uint8Array(await object!.arrayBuffer());
    assert.deepEqual(bytes.slice(-3), tail);
  } finally { await h.close(); }
});

test('R2 multipart abort can be retried after an interrupted cleanup', async () => {
  const h = await createCloudHarness();
  try {
    const upload = await h.assets.createMultipartUpload('test/exports/abort/contacts.csv');
    await upload.abort();
    await h.assets.resumeMultipartUpload('test/exports/abort/contacts.csv', upload.uploadId).abort();
  } finally { await h.close(); }
});
