import assert from 'node:assert/strict';
import type { createCloudHarness } from './cloud-harness.ts';
type Harness = Awaited<ReturnType<typeof createCloudHarness>>;
export const googleEnvironment = { BETTER_AUTH_URL: 'https://test.invalid', GOOGLE_CLIENT_ID: 'login-client', GOOGLE_CONNECTOR_CLIENT_ID: 'contacts-client',
  GOOGLE_CONNECTOR_CLIENT_SECRET: 'test-only-client-secret', CONNECTOR_TOKEN_KEYRING: JSON.stringify({ active: 'v1', keys: { v1: Buffer.alloc(32, 13).toString('base64url') } }) };
export const googleActor = { workspaceId: 'test', userId: 'owner', authMethod: 'web' as const };
export function googlePerson(sourceId = 'a', name = 'Google Ana') {
  const metadata = { sourcePrimary: true, primary: true, source: { type: 'CONTACT', id: sourceId } };
  return { resourceName: 'people/' + sourceId, metadata: { sources: [{ type: 'CONTACT', id: sourceId, etag: 'v1' }] }, names: [{ displayName: name, metadata }],
    emailAddresses: [{ value: 'ana@example.test', type: 'work', metadata }, { value: 'second@example.test', type: 'home', metadata }],
    phoneNumbers: [{ value: '+351 912 345 678', canonicalForm: '+351912345678', type: 'mobile', metadata }], organizations: [{ name: 'Company', title: 'Engineer', metadata }],
    biographies: [{ value: 'Never import this note' }] };
}
export async function stagedGoogleContact(h: Harness, people = [googlePerson()]) {
  await h.db.prepare("INSERT OR IGNORE INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('owner', 'Owner', 'owner@test.invalid', 1, 1, 1)").run();
  await h.db.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role) VALUES ('test', 'owner', 'owner')").run();
  const epoch = (await h.db.prepare("SELECT epoch FROM workspace_sync_state WHERE workspace_id = 'test'").first<{ epoch: string }>())!.epoch;
  const begin = await h.providers.beginGoogleConnection(h.db, googleActor, googleEnvironment, { purpose: 'contacts', expected_epoch: epoch }, googleEnvironment.BETTER_AUTH_URL);
  const fetcher = async (url: string) => url.endsWith('/userinfo') ? Response.json({ sub: 'google-owner', name: 'Owner', email: 'owner@example.test', email_verified: true })
    : Response.json({ access_token: 'test-only-access-secret', refresh_token: 'test-only-refresh-secret', expires_in: 3600, token_type: 'Bearer', scope: 'openid email profile https://www.googleapis.com/auth/contacts.readonly' });
  const connection = await h.providers.completeGoogleConnection(h.db, googleActor, googleEnvironment,
    new URLSearchParams({ code: 'test-code', state: new URL(begin.authorization_url).searchParams.get('state')! }), fetcher);
  Object.assign(h.emailEnv, googleEnvironment);
  const run = await h.contactDownloads.startGoogleContactsDownload(h.db, googleActor, googleEnvironment, connection.id, { operation_id: crypto.randomUUID(), expected_epoch: epoch, expected_authorization_revision: connection.authorization_revision });
  await h.contactDownloads.advanceGoogleContactsDownload(h.db, googleEnvironment, { kind: 'google-contacts', version: 1, workspaceId: 'test', connectionId: connection.id, runId: run.id }, async () => Response.json({ connections: people, nextSyncToken: 'test-only-cursor' }));
  const review = await h.contactDownloads.reviewGoogleContacts(h.db, googleActor, connection.id);
  const query = new URLSearchParams({ generation: review.generation!, source_id: 'a' });
  const preview = await h.contactImports.googleImportPreview(h.db, googleActor, connection.id, query);
  return { connection, epoch, preview, query, fetcher };
}
export function googleImportBody(preview: Awaited<ReturnType<Harness['contactImports']['googleImportPreview']>>, overrides: Record<string, unknown> = {}) {
  return { expected_epoch: preview.epoch, expected_authorization_revision: preview.connection.authorization_revision, generation: preview.generation,
    source_id: preview.facts.sourceId, facts_revision: preview.facts_revision, contact_id: null, create_name: 'My Ana', use_name: false, emails: [0], phones: [0], ...overrides };
}
export async function currentPerson(h: Harness, id: number) { const result = await h.call('contacts/' + id); assert.equal(result.status, 200); return result.body.contact; }
