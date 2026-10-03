import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readFormDataBody,
  readJsonBody,
  RequestBodyError,
} from '../lib/request-body.ts';

function chunkedRequest(chunks: string[], headers: HeadersInit = {}): Request {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunk));
    },
  });

  return new Request('https://bonds.test/api/test', {
    method: 'POST',
    headers,
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

test('bounded JSON parsing accepts a valid request', async () => {
  const request = new Request('https://bonds.test/api/test', {
    method: 'POST',
    body: JSON.stringify({ name: 'Ada' }),
  });

  assert.deepEqual(await readJsonBody(request, { maximumBytes: 64 }), { name: 'Ada' });
});

test('bounded JSON parsing returns a client error for malformed JSON and UTF-8', async () => {
  await assert.rejects(
    readJsonBody(chunkedRequest(['{"name":'])),
    (error: unknown) => error instanceof RequestBodyError
      && error.status === 400
      && error.message === 'Valid JSON is required.'
  );

  const invalidUtf8 = new Request('https://bonds.test/api/test', {
    method: 'POST',
    body: new Uint8Array([0xc3, 0x28]),
  });
  await assert.rejects(
    readJsonBody(invalidUtf8),
    (error: unknown) => error instanceof RequestBodyError
      && error.status === 400
      && error.message === 'Request body must be valid UTF-8.'
  );
});

test('bounded parsing rejects oversized declared and chunked bodies with 413', async () => {
  const declared = chunkedRequest(['{}'], { 'content-length': '1000' });
  await assert.rejects(
    readJsonBody(declared, { maximumBytes: 10, sizeLimitMessage: 'Too large.' }),
    (error: unknown) => error instanceof RequestBodyError
      && error.status === 413
      && error.message === 'Too large.'
  );

  const chunked = chunkedRequest(['{"value":"', '1234567890', '"}']);
  await assert.rejects(
    readJsonBody(chunked, { maximumBytes: 12 }),
    (error: unknown) => error instanceof RequestBodyError && error.status === 413
  );
});

test('bounded multipart parsing preserves files and rejects oversized streams', async () => {
  const formData = new FormData();
  formData.set('file', new File(['BEGIN:VCARD\nEND:VCARD'], 'contacts.vcf'));
  const request = new Request('https://bonds.test/api/import/vcard', {
    method: 'POST',
    body: formData,
  });
  const parsed = await readFormDataBody(request, { maximumBytes: 1024 });
  const file = parsed.get('file');
  assert.ok(file instanceof File);
  assert.equal(file.name, 'contacts.vcf');
  assert.equal(await file.text(), 'BEGIN:VCARD\nEND:VCARD');

  const contentType = request.headers.get('content-type');
  assert.ok(contentType);
  const oversized = chunkedRequest(['12345', '67890'], { 'content-type': contentType });
  await assert.rejects(
    readFormDataBody(oversized, { maximumBytes: 8 }),
    (error: unknown) => error instanceof RequestBodyError && error.status === 413
  );
});
