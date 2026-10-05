import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';
import type { GoogleGmailError } from '../lib/cloud/google-gmail.ts';

const TOKEN = 'fixture-only-gmail-access';
const CHECKPOINT = '18446744073709551610';
function message(extra: Record<string, unknown> = {}) {
  return { id: 'message-1', threadId: 'thread-1', historyId: CHECKPOINT, internalDate: '1750000000000', labelIds: ['INBOX'],
    payload: { headers: [{ name: 'From', value: 'Person <person@example.test>' }, { name: 'To', value: 'owner@example.test' }] }, ...extra };
}
function reason(expected: GoogleGmailError['reason']) {
  return (error: unknown) => {
    assert.equal((error as GoogleGmailError).reason, expected);
    assert.ok(!String(error).includes(TOKEN)); assert.ok(!String(error).includes('private-provider-detail'));
    return true;
  };
}

test('Gmail reads use the fixed account endpoint, bounded metadata fields and exact string checkpoints', async () => {
  const h = await createCloudHarness(); try {
    const result = await h.googleGmail.googleGmailProfile(TOKEN, async (address, request) => {
      const url = new URL(address);
      assert.equal(url.origin, 'https://gmail.googleapis.com'); assert.equal(url.pathname, '/gmail/v1/users/me/profile');
      assert.equal(url.searchParams.get('fields'), 'emailAddress,historyId');
      assert.equal(request.method, 'GET'); assert.equal(request.redirect, 'error'); assert.ok(request.signal);
      assert.equal((request.headers as Record<string, string>).Authorization, 'Bearer ' + TOKEN);
      assert.ok(!url.href.includes(TOKEN)); assert.equal(request.body, undefined);
      return Response.json({ emailAddress: 'Owner@Example.test', historyId: CHECKPOINT, messagesTotal: 10000 });
    });
    assert.deepEqual(result, { email: 'owner@example.test', historyId: CHECKPOINT });
    assert.deepEqual(await h.googleGmail.googleGmailProfile(TOKEN, async () => Response.json({ emailAddress: 'owner@example.test', historyId: '0' })),
      { email: 'owner@example.test', historyId: '0' });
  } finally { await h.close(); }
});

test('selected-label pages never send a forbidden search query or promise a complete time window', async () => {
  const h = await createCloudHarness(); try {
    const page = await h.googleGmail.googleGmailMessagesPage(TOKEN, 'Label_2', 'opaque-page', async (address) => {
      const url = new URL(address);
      assert.equal(url.pathname, '/gmail/v1/users/me/messages');
      assert.deepEqual(url.searchParams.getAll('labelIds'), ['Label_2']);
      assert.equal(url.searchParams.get('maxResults'), '100'); assert.equal(url.searchParams.get('includeSpamTrash'), 'false');
      assert.equal(url.searchParams.has('q'), false); assert.equal(url.searchParams.get('pageToken'), 'opaque-page');
      return Response.json({ messages: [{ id: 'message-1', threadId: 'thread-1', snippet: 'private-provider-detail' }], nextPageToken: 'next-page' });
    });
    assert.deepEqual(page, { messages: [{ id: 'message-1', threadId: 'thread-1' }], next: 'next-page' });
    let fetched = false;
    await assert.rejects(h.googleGmail.googleGmailMessagesPage(TOKEN, '../foreign-user', null, async () => { fetched = true; return Response.json({}); }), reason('invalid'));
    assert.equal(fetched, false);
    await assert.rejects(h.googleGmail.googleGmailMessagesPage(TOKEN, null, 'loop', async () => Response.json({ nextPageToken: 'loop' })), reason('invalid'));
    await assert.rejects(h.googleGmail.googleGmailMessagesPage(TOKEN, null, null, async () => Response.json({ messages: Array.from({ length: 101 }, (_, i) => ({ id: String(i), threadId: 't' })) })), reason('invalid'));
  } finally { await h.close(); }
});

test('message reads discard bodies, snippets, attachments and subjects unless subjects are explicitly chosen', async () => {
  const h = await createCloudHarness(); try {
    const raw = message({ raw: 'private-provider-detail', snippet: 'private-provider-detail', payload: {
      body: { data: 'private-provider-detail' }, parts: [{ filename: 'private-provider-detail' }],
      headers: [{ name: 'From', value: 'Person <person@example.test>' }, { name: 'To', value: 'Owner\r\n <owner@example.test>' },
        { name: 'Subject', value: 'private-provider-detail' }, { name: 'X-Unrequested', value: 'private-provider-detail' }],
    } });
    const result = await h.googleGmail.googleGmailMessageMetadata(TOKEN, 'message-1', false, async (address) => {
      const url = new URL(address);
      assert.equal(url.searchParams.get('format'), 'metadata');
      assert.ok(!url.searchParams.get('fields')!.includes('body'));
      assert.ok(!url.searchParams.getAll('metadataHeaders').includes('Subject'));
      assert.ok(!url.searchParams.getAll('metadataHeaders').includes('Date'));
      return Response.json(raw);
    });
    assert.equal(result.receivedAt, 1750000000000); assert.equal(result.historyId, CHECKPOINT);
    assert.deepEqual(result.headers.to, ['Owner <owner@example.test>']);
    assert.ok(!JSON.stringify(result).includes('private-provider-detail'));
    assert.equal(result.headers.subject, undefined);
    const chosen = await h.googleGmail.googleGmailMessageMetadata(TOKEN, 'message-1', true, async (address) => {
      assert.ok(new URL(address).searchParams.getAll('metadataHeaders').includes('Subject')); return Response.json(raw);
    });
    assert.deepEqual(chosen.headers.subject, ['private-provider-detail']);
    assert.ok(!('payload' in chosen)); assert.ok(!('raw' in chosen));
  } finally { await h.close(); }
});

test('malformed identities, dates, duplicate labels, headers and streamed oversized responses fail without exposing metadata', async () => {
  const h = await createCloudHarness(); try {
    const unsupported = [message({ id: 'different-message' }), message({ historyId: 123 }), message({ historyId: '18446744073709551616' }),
      message({ internalDate: '8640000000000001' }), message({ internalDate: 'not-a-date' }), message({ labelIds: ['INBOX', 'INBOX'] }),
      message({ payload: { headers: [{ name: 'From', value: 'private-provider-detail\u0000' }] } }),
      message({ payload: { headers: [{ name: 'From', value: 'private-provider-detail\nInjected: header' }] } }),
      message({ payload: { headers: Array.from({ length: 9 }, () => ({ name: 'To', value: 'someone@example.test' })) } })];
    for (const raw of unsupported) await assert.rejects(h.googleGmail.googleGmailMessageMetadata(TOKEN, 'message-1', false, async () => Response.json(raw)), reason('invalid'));
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(128 * 1024)); }, cancel() { cancelled = true; } });
    await assert.rejects(h.googleGmail.googleGmailMessageMetadata(TOKEN, 'message-1', false, async () => new Response(stream)), reason('invalid'));
    assert.equal(cancelled, true);
    await assert.rejects(h.googleGmail.googleGmailProfile(TOKEN, async () => new Response(new Uint8Array([0xff]))), reason('invalid'));
  } finally { await h.close(); }
});

test('history preserves all four change kinds and uint64 order while ignoring duplicate generic message projections', async () => {
  const h = await createCloudHarness(); try {
    const start = '18446744073709551600', later = '18446744073709551601';
    const result = await h.googleGmail.googleGmailHistoryPage(TOKEN, start, null, async (address) => {
      const url = new URL(address);
      assert.equal(url.pathname, '/gmail/v1/users/me/history'); assert.equal(url.searchParams.get('startHistoryId'), start);
      assert.equal(url.searchParams.has('labelId'), false); assert.equal(url.searchParams.has('q'), false);
      return Response.json({ historyId: CHECKPOINT, nextPageToken: 'history-next', history: [{ id: later,
        messages: [{ id: 'message-1', threadId: 'thread-1' }],
        messagesAdded: [{ message: { id: 'message-1', threadId: 'thread-1', snippet: 'private-provider-detail' } }],
        messagesDeleted: [{ message: { id: 'message-2', threadId: 'thread-2' } }],
        labelsAdded: [{ message: { id: 'message-3', threadId: 'thread-3' }, labelIds: ['INBOX'] }],
        labelsRemoved: [{ message: { id: 'message-4', threadId: 'thread-4' }, labelIds: ['INBOX'] }],
      }] });
    });
    assert.equal(result.historyId, CHECKPOINT); assert.equal(result.next, 'history-next');
    assert.deepEqual(result.changes.map((item) => item.kind), ['message_added', 'message_deleted', 'labels_added', 'labels_removed']);
    assert.ok(result.changes.every((item) => item.historyId === later));
    assert.ok(!JSON.stringify(result).includes('private-provider-detail')); assert.equal(result.changes.length, 4);
    for (const history of [[{ id: start }], [{ id: '18446744073709551609' }, { id: later }], [{ id: '18446744073709551611' }]]) {
      await assert.rejects(h.googleGmail.googleGmailHistoryPage(TOKEN, start, null, async () => Response.json({ historyId: CHECKPOINT, history })), reason('invalid'));
    }
  } finally { await h.close(); }
});

test('history expiry, missing messages, denied access and rate limiting remain distinct without logging provider errors', async () => {
  const h = await createCloudHarness(); try {
    const gone = async () => Response.json({ error: { message: 'private-provider-detail' } }, { status: 404 });
    await assert.rejects(h.googleGmail.googleGmailHistoryPage(TOKEN, '123', null, gone), reason('history_expired'));
    await assert.rejects(h.googleGmail.googleGmailMessageMetadata(TOKEN, 'message-1', false, gone), reason('missing'));
    await assert.rejects(h.googleGmail.googleGmailProfile(TOKEN, async () => new Response('private-provider-detail', { status: 401 })), reason('permission'));
    await assert.rejects(h.googleGmail.googleGmailProfile(TOKEN, async () => Response.json({ error: { message: 'private-provider-detail', errors: [{ reason: 'insufficientPermissions' }] } }, { status: 403 })), reason('permission'));
    for (const status of [429, 503]) await assert.rejects(h.googleGmail.googleGmailProfile(TOKEN, async () => new Response('private-provider-detail', { status, headers: { 'Retry-After': '10000' } })), (error: unknown) => {
      reason('retry')(error); assert.equal((error as GoogleGmailError).retryAfter, 900); return true;
    });
    await assert.rejects(h.googleGmail.googleGmailProfile(TOKEN, async () => Response.json({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }, { status: 403, headers: { 'Retry-After': '5' } })), (error: unknown) => {
      reason('retry')(error); assert.equal((error as GoogleGmailError).retryAfter, 5); return true;
    });
    await assert.rejects(h.googleGmail.googleGmailProfile(TOKEN, async () => { throw new Error('private-provider-detail'); }), reason('retry'));
  } finally { await h.close(); }
});

test('label discovery strips extra provider fields and rejects unsupported or duplicate labels', async () => {
  const h = await createCloudHarness(); try {
    const labels = [{ id: 'INBOX', name: 'Inbox', type: 'system', color: 'private-provider-detail' }, { id: 'Label_1', name: 'Personal', type: 'user' }];
    const result = await h.googleGmail.googleGmailLabels(TOKEN, async (address) => {
      const url = new URL(address); assert.equal(url.pathname, '/gmail/v1/users/me/labels');
      assert.equal(url.searchParams.get('fields'), 'labels(id,name,type)'); return Response.json({ labels });
    });
    assert.deepEqual(result, [{ id: 'INBOX', name: 'Inbox', type: 'system' }, { id: 'Label_1', name: 'Personal', type: 'user' }]);
    for (const invalid of [[labels[0], labels[0]], [{ id: 'INBOX', name: 'Inbox', type: 'unknown' }]]) {
      await assert.rejects(h.googleGmail.googleGmailLabels(TOKEN, async () => Response.json({ labels: invalid })), reason('invalid'));
    }
  } finally { await h.close(); }
});
