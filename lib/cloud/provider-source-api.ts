import { changeProviderFields } from './provider-field-controls';
import { ContactMethodError } from '@/packages/domain/src/contact-methods';
import { ContactRevisionError } from '@/lib/contact-revision';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { ProviderSourceError } from '@/packages/domain/src/provider-sources';
import { ProviderConnectionError } from './provider-vault';
import { recoveryErrorResponse } from './recovery-contract';
import { savedProviderSources, unlinkProviderSource } from './google-contact-imports';
import type { ConnectionActor } from './provider-connections';

export async function handleProviderSources(request: Request, actor: ConnectionActor, path: string[]) {
  try {
    if (!/^[1-9]\d{0,14}$/.test(path[1])) throw new ProviderSourceError('Person not found.', 404);
    const { env } = getCloudflareContext();
    const contactId = Number(path[1]);
    if (request.method === 'GET' && path.length === 3) return Response.json(await savedProviderSources(env.DB, actor, contactId), { headers: { 'Cache-Control': 'no-store' } });
    if (['DELETE', 'PATCH'].includes(request.method) && path.length === 4) {
      if (request.headers.get('origin') !== new URL(env.BETTER_AUTH_URL || process.env.BETTER_AUTH_URL || '').origin) throw new ProviderSourceError('Unlink this source from this Everclose app.', 403);
      const body = await readJsonBody(request, { maximumBytes: request.method === 'PATCH' ? 32768 : 1024 });
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestBodyError('Use a JSON object.', 400);
      if (request.method === 'PATCH') return Response.json(await changeProviderFields(env.DB, actor, contactId, path[3], body as Record<string, unknown>), { headers: { 'Cache-Control': 'no-store' } });
      return Response.json(await unlinkProviderSource(env.DB, actor, contactId, path[3], body as Record<string, unknown>));
    }
    return Response.json({ error: 'Source route not found.' }, { status: 404 });
  } catch (error) {
    if (error instanceof ProviderSourceError || error instanceof ProviderConnectionError || error instanceof RequestBodyError) return Response.json({ error: error.message }, { status: error.status, headers: { 'Cache-Control': 'no-store' } });
    if (error instanceof ContactMethodError || error instanceof ContactRevisionError) return Response.json({ error: error.message }, { status: 400 });
    if (String(error).includes('PROVIDER_RULE_AUTHORITY')) return Response.json({ error: 'Another Google source already follows this field. Keep its value there before choosing this source.', }, { status: 409 });
    if (/PROVIDER_(RULE|LINK)_LIMIT/.test(String(error))) return Response.json({ error: 'These source details exceed the person’s saved-source limit. Unlink an unused source first.' }, { status: 413 });
    const recovery = recoveryErrorResponse(error); if (recovery) return recovery;
    console.error('cloud.provider_source.failed');
    return Response.json({ error: 'This source changed. Refresh before saving your choices.' }, { status: 409 });
  }
}
