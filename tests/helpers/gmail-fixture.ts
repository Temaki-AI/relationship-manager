import assert from 'node:assert/strict';
import { createCloudHarness } from './cloud-harness.ts';
import type { GmailChoices } from '../../packages/domain/src/gmail.ts';

export const gmailActor = { workspaceId: 'test', userId: 'owner', authMethod: 'web' as const };
export const gmailEnvironment = { BETTER_AUTH_URL: 'https://test.invalid', GOOGLE_CLIENT_ID: 'login-client', GOOGLE_GMAIL_CLIENT_ID: 'gmail-client',
  GOOGLE_GMAIL_CLIENT_SECRET: 'fixture-gmail-secret', CONNECTOR_TOKEN_KEYRING: JSON.stringify({ active: 'v1', keys: { v1: Buffer.alloc(32, 19).toString('base64url') } }) };
export const gmailChoices: GmailChoices = { label_ids: ['INBOX', 'SENT'], own_addresses: ['owner@example.test'], mode: 'existing_people', past_days: 90, scan_limit: 1000, retain_subject: false };
export async function gmailFixture() {
  const h = await createCloudHarness();
  await h.db.prepare("INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES('owner','Owner','owner@example.test',1,1,1),('second','Second','second@example.test',1,1,1)").run();
  await h.db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES('test','owner','owner'),('other','second','owner')").run();
  Object.assign(h.emailEnv, gmailEnvironment);
  const epoch = (await h.db.prepare("SELECT epoch FROM workspace_sync_state WHERE workspace_id = 'test'").first<{ epoch: string }>())!.epoch;
  const calls: Array<{ url: string; request: RequestInit }> = [];
  const messages = new Map<string, Record<string, unknown>>();
  let profileHistory = '9007199254740993';
  const lists = new Map<string, Record<string, unknown>>();
  const histories = new Map<string, Record<string, unknown> | number>();
  let hook: ((url: URL, request: RequestInit) => Promise<Response | null>) | undefined;
  const fetcher = async (raw: string, request: RequestInit) => {
    calls.push({ url: raw, request }); assert.equal(request.redirect, 'error'); assert.ok(request.signal);
    const url = new URL(raw), intercept = await hook?.(url, request); if (intercept) return intercept;
    if (raw === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'Bearer', expires_in: 3600, scope: 'openid email profile https://www.googleapis.com/auth/gmail.metadata' });
    if (raw === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({ sub: 'google-owner', email: 'owner@example.test', email_verified: true, name: 'Gmail Owner' });
    if (raw === 'https://oauth2.googleapis.com/revoke') return new Response(null, { status: 200 });
    assert.equal(url.origin, 'https://gmail.googleapis.com'); assert.equal(request.method, 'GET'); assert.equal(url.searchParams.has('q'), false);
    assert.equal(new Headers(request.headers).get('authorization'), 'Bearer fixture-access');
    if (url.pathname.endsWith('/profile')) return Response.json({ emailAddress: 'owner@example.test', historyId: profileHistory });
    if (url.pathname.endsWith('/labels')) return Response.json({ labels: [{ id: 'INBOX', name: 'Inbox', type: 'system' }, { id: 'SENT', name: 'Sent', type: 'system' }, { id: 'Label_1', name: 'Friends', type: 'user' }] });
    if (url.pathname.endsWith('/messages')) return Response.json(lists.get((url.searchParams.get('labelIds') ?? '') + ':' + (url.searchParams.get('pageToken') ?? '')) ?? { messages: [...messages.keys()].map((id) => ({ id, threadId: 'thread_' + id })) });
    if (url.pathname.endsWith('/history')) {
      const response = histories.get(url.searchParams.get('pageToken') ?? '') ?? { history: [], historyId: profileHistory };
      return typeof response === 'number' ? Response.json({ error: {} }, { status: response }) : Response.json(response);
    }
    const id = url.pathname.split('/').at(-1)!; const message = messages.get(id);
    return message ? Response.json(message) : Response.json({ error: {} }, { status: 404 });
  };
  const attempt = await h.providers.beginGoogleConnection(h.db, gmailActor, gmailEnvironment, { purpose: 'gmail', expected_epoch: epoch }, gmailEnvironment.BETTER_AUTH_URL);
  const connection = await h.providers.completeGoogleConnection(h.db, gmailActor, gmailEnvironment, new URLSearchParams({ state: new URL(attempt.authorization_url).searchParams.get('state')!, code: 'fixture-code' }), fetcher);
  async function save(choices: GmailChoices = gmailChoices) {
    const source = await h.gmailDownloads.reviewGmailSource(h.db, gmailActor, connection.id);
    return h.gmailDownloads.saveGmailChoices(h.db, gmailActor, gmailEnvironment, connection.id, { choices, expected_epoch: epoch, expected_authorization_revision: connection.authorization_revision, expected_settings_revision: source?.settings_revision ?? 0 }, fetcher);
  }
  async function start(mode: 'full' | 'incremental' = 'full', operationId = crypto.randomUUID()) {
    const source = (await h.gmailDownloads.reviewGmailSource(h.db, gmailActor, connection.id))!;
    const body = { operation_id: operationId, mode, expected_epoch: epoch, expected_authorization_revision: connection.authorization_revision, expected_settings_revision: source.settings_revision };
    return { body, run: await h.gmailDownloads.startGmailDownload(h.db, gmailActor, gmailEnvironment, connection.id, body) };
  }
  async function advance(id: string) { return h.gmailDownloads.advanceGmailDownload(h.db, gmailActor, gmailEnvironment, connection.id, id, fetcher); }
  async function finish(id: string, maximum = 100) {
    let run; for (let step = 0; step < maximum; step++) { run = await advance(id); if (run.status !== 'active') return run; }
    throw new Error('Fixture download did not finish within its step bound');
  }
  async function review(query = new URLSearchParams()) { return h.gmailDownloads.reviewGmailMessages(h.db, gmailActor, connection.id, query); }
  function message(id: string, options: { at?: number; from?: string; to?: string; labels?: string[]; headers?: Array<{ name: string; value: string }> } = {}) {
    messages.set(id, { id, threadId: 'thread_' + id, historyId: profileHistory, internalDate: String(options.at ?? Date.now() - 1000), labelIds: options.labels ?? ['INBOX'],
      snippet: 'BODY MUST NOT BE SAVED', payload: { body: { data: 'BODY MUST NOT BE SAVED' }, parts: [{ filename: 'PRIVATE ATTACHMENT' }], headers: [
        { name: 'From', value: options.from ?? 'Friend <friend@example.test>' }, { name: 'To', value: options.to ?? 'owner@example.test' },
        { name: 'Subject', value: 'Optional fixture subject' }, { name: 'Message-ID', value: '<fixture-' + id + '@example.test>' }, ...(options.headers ?? []),
      ] } });
  }
  return { h, actor: gmailActor, env: gmailEnvironment, epoch, connection, calls, messages, lists, histories, fetcher, save, start, advance, finish, review, message,
    setHook(value: typeof hook) { hook = value; }, setHistory(value: string) { profileHistory = value; } };
}
