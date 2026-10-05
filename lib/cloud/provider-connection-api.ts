import { getCloudflareContext } from '@opennextjs/cloudflare';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { beginGoogleConnection, completeGoogleConnection, disconnectGoogleConnection, googleAuthorizationPurpose, listProviderConnections, type ConnectionActor } from './provider-connections';
import { ProviderConnectionError } from './provider-vault';
import { recoveryErrorResponse } from './recovery-contract';
import type { GoogleConnectionPurpose, ProviderEnvironment } from './google-provider';
import { advanceGoogleContactsDownload, changeGoogleContactsSchedule, reviewGoogleContacts, startGoogleContactsDownload } from './google-contact-downloads';
import { googleImportPreview, importGoogleContact } from './google-contact-imports';
import { ProviderSourceError } from '@/packages/domain/src/provider-sources';
import { ContactMethodError } from '@/packages/domain/src/contact-methods';
import { IdempotencyError } from '@/lib/idempotency';
import { ContactRevisionError } from '@/lib/contact-revision';
import { advanceCalendarDiscovery, reviewCalendars, selectCalendars, startCalendarDiscovery } from './google-calendar-resources';
import { advanceEventDownload, cancelEventDownload, changeCalendarEventSchedule, reviewCalendarEvents, startEventDownload } from './google-event-downloads';
import { eventLinkPreview, linkCalendarEvent } from './calendar-event-links';
import { advanceOwnedCalendar, discardUnsentOwnedCalendar, reviewOwnedCalendar, startOwnedCalendar } from './google-owned-calendar';

import { reviewPlanPublication, preparePlanPublication, advancePlanPublication, discardPlanPublication } from './calendar-plan-publications';
import { previewGmailMailbox, reviewGmailConnection } from './google-gmail-connection';
import { advanceGmailDownload, cancelGmailDownload, reviewGmailMessages, saveGmailChoices, startGmailDownload } from './google-gmail-downloads';
import { GmailChoicesError } from '@/packages/domain/src/gmail';

async function objectBody(request: Request, maximumBytes = 4096) {
  const body = await readJsonBody(request, { maximumBytes });
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestBodyError('Use a JSON object.', 400);
  return body as Record<string, unknown>;
}
function connectionPage(purpose: GoogleConnectionPurpose | null) {
  return '/connections/google' + (purpose === 'gmail' ? '/gmail' : purpose === 'calendar-publish' ? '/publish' : purpose === 'calendar' ? '/calendar' : '');
}
export async function handleProviderConnections(request: Request, actor: ConnectionActor, path: string[]) {
  const { env } = getCloudflareContext();
  const environment = { ...process.env, ...env } as unknown as ProviderEnvironment;
  const callback = path.join('/') === 'connections/google/callback' && request.method === 'GET';
  let callbackPage = connectionPage(null);
  try {
    if (path.length === 1 && request.method === 'GET') return Response.json(await listProviderConnections(env.DB, actor, environment), { headers: { 'Cache-Control': 'no-store' } });
    if (path.join('/') === 'connections/google/authorize' && request.method === 'POST') return Response.json(await beginGoogleConnection(env.DB, actor, environment, await objectBody(request), request.headers.get('origin')));
    if (path.length >= 4 && path[2] === 'gmail') {
      const url = new URL(request.url);
      if (path.length === 4 && path[3] === 'messages' && request.method === 'GET') return Response.json(await reviewGmailMessages(env.DB, actor, path[1], url.searchParams), { headers: { 'Cache-Control': 'no-store' } });
      if (url.search) throw new ProviderConnectionError('Use the current Gmail download without query parameters.', 400);
      if (request.headers.get('origin') !== new URL(environment.BETTER_AUTH_URL || '').origin) throw new ProviderConnectionError('Manage Gmail from this Everclose app.', 403);
      const body = await objectBody(request, 16384);
      const result = path.length === 4 && path[3] === 'settings' && request.method === 'PATCH' ? await saveGmailChoices(env.DB, actor, environment, path[1], body)
        : path.length === 4 && path[3] === 'downloads' && request.method === 'POST' ? await startGmailDownload(env.DB, actor, environment, path[1], body)
          : path.length === 6 && path[3] === 'downloads' && path[5] === 'step' && request.method === 'POST' && Object.keys(body).length === 0 ? await advanceGmailDownload(env.DB, actor, environment, path[1], path[4])
            : path.length === 5 && path[3] === 'downloads' && request.method === 'DELETE' && Object.keys(body).length === 0 ? await cancelGmailDownload(env.DB, actor, path[1], path[4]) : null;
      return result ? Response.json(result, { headers: { 'Cache-Control': 'no-store' } }) : Response.json({ error: 'Gmail download route not found.' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }
    if (path.length === 3 && path[2] === 'gmail') {
      if (new URL(request.url).search) throw new ProviderConnectionError('Use the current Gmail connection without query parameters.', 400);
      if (request.method === 'GET') return Response.json(await reviewGmailConnection(env.DB, actor, path[1]), { headers: { 'Cache-Control': 'no-store' } });
      if (request.method === 'POST') {
        if (request.headers.get('origin') !== new URL(environment.BETTER_AUTH_URL || '').origin) throw new ProviderConnectionError('Preview Gmail from this Everclose app.', 403);
        return Response.json(await previewGmailMailbox(env.DB, actor, environment, path[1], await objectBody(request)), { headers: { 'Cache-Control': 'no-store' } });
      }
    }
    if (path.length >= 3 && path[2] === 'plan-publications') {
      if (path.length === 4 && request.method === 'GET') return Response.json(await reviewPlanPublication(env.DB, actor, environment, path[1], path[3]), { headers: { 'Cache-Control': 'no-store' } });
      if (request.headers.get('origin') !== new URL(environment.BETTER_AUTH_URL || '').origin) throw new ProviderConnectionError('Review this publication from this Everclose app.', 403);
      const body = await objectBody(request, 16384);
      const result = path.length === 4 && request.method === 'POST' ? await preparePlanPublication(env.DB, actor, environment, path[1], path[3], body)
        : path.length === 4 && request.method === 'DELETE' ? await discardPlanPublication(env.DB, actor, path[1], path[3], body)
          : path.length === 5 && path[4] === 'step' && request.method === 'POST' ? await advancePlanPublication(env.DB, actor, environment, path[1], path[3], body) : null;
      return result ? Response.json(result, { headers: { 'Cache-Control': 'no-store' } }) : Response.json({ error: 'Plan publication route not found.' }, { status: 404 });
    }
    if (path.length >= 3 && path[2] === 'owned-calendar') {
      if (path.length === 3 && request.method === 'GET') return Response.json(await reviewOwnedCalendar(env.DB, actor, path[1]), { headers: { 'Cache-Control': 'no-store' } });
      if (request.headers.get('origin') !== new URL(environment.BETTER_AUTH_URL || '').origin) throw new ProviderConnectionError('Review calendar setup from this Everclose app.', 403);
      const body = await objectBody(request);
      const result = path.length === 3 && request.method === 'POST' ? await startOwnedCalendar(env.DB, actor, environment, path[1], body)
        : path.length === 3 && request.method === 'DELETE' ? await discardUnsentOwnedCalendar(env.DB, actor, path[1], body)
          : path.length === 4 && path[3] === 'step' && request.method === 'POST' ? await advanceOwnedCalendar(env.DB, actor, environment, path[1], body) : null;
      return result ? Response.json(result, { headers: { 'Cache-Control': 'no-store' } }) : Response.json({ error: 'Calendar setup route not found.' }, { status: 404 });
    }
    if (path.length >= 3 && path[2] === 'calendars') {
      if (path.length === 3 && request.method === 'GET') return Response.json(await reviewCalendars(env.DB, actor, path[1], new URL(request.url).searchParams), { headers: { 'Cache-Control': 'no-store' } });
      if (path.length === 4 && path[3] === 'events' && request.method === 'GET') return Response.json(await reviewCalendarEvents(env.DB, actor, path[1], new URL(request.url).searchParams), { headers: { 'Cache-Control': 'no-store' } });
      if (path.length === 5 && path[3] === 'events' && path[4] === 'link-preview' && request.method === 'GET') return Response.json(await eventLinkPreview(env.DB, actor, path[1], new URL(request.url).searchParams), { headers: { 'Cache-Control': 'no-store' } });
      if (request.headers.get('origin') !== new URL(environment.BETTER_AUTH_URL || '').origin) throw new ProviderConnectionError('Review calendars from this Everclose app.', 403);
      const body = await objectBody(request, 32768);
      const result = path.length === 3 && request.method === 'POST' ? await startCalendarDiscovery(env.DB, actor, environment, path[1], body)
        : path.length === 5 && path[3] === 'events' && path[4] === 'schedule' && request.method === 'PATCH' ? await changeCalendarEventSchedule(env.DB, actor, path[1], body)
        : path.length === 4 && path[3] === 'events' && request.method === 'POST' ? await startEventDownload(env.DB, actor, environment, path[1], body)
          : path.length === 4 && path[3] === 'events' && request.method === 'DELETE' && Object.keys(body).length === 1 ? await cancelEventDownload(env.DB, actor, path[1], body.run_id)
            : path.length === 5 && path[3] === 'events' && path[4] === 'link' && request.method === 'POST' ? await linkCalendarEvent(env.DB, actor, path[1], body)
          : path.length === 5 && path[3] === 'events' && path[4] === 'step' && request.method === 'POST' && Object.keys(body).length === 1 ? await advanceEventDownload(env.DB, actor, environment, path[1], body.run_id)
        : path.length === 4 && path[3] === 'step' && request.method === 'POST' && Object.keys(body).length === 1 ? await advanceCalendarDiscovery(env.DB, actor, environment, path[1], body.run_id)
          : path.length === 4 && path[3] === 'selection' && request.method === 'PATCH' ? await selectCalendars(env.DB, actor, path[1], body) : null;
      if (result) return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
      return Response.json({ error: 'Calendar discovery route not found.' }, { status: 404 });
    }
    if (path.length >= 3 && path[2] === 'contacts') {
      if (path.length === 3 && request.method === 'GET') return Response.json(await reviewGoogleContacts(env.DB, actor, path[1], new URL(request.url).searchParams), { headers: { 'Cache-Control': 'no-store' } });
      if (path.length === 4 && path[3] === 'import-preview' && request.method === 'GET') return Response.json(await googleImportPreview(env.DB, actor, path[1], new URL(request.url).searchParams), { headers: { 'Cache-Control': 'no-store' } });
      if (request.headers.get('origin') !== new URL(environment.BETTER_AUTH_URL || '').origin) throw new ProviderConnectionError('Start this download from this Everclose app.', 403);
      if (path.length === 4 && path[3] === 'schedule' && request.method === 'PATCH') return Response.json(await changeGoogleContactsSchedule(env.DB, actor, path[1], await objectBody(request)), { headers: { 'Cache-Control': 'no-store' } });
      if (path.length === 4 && path[3] === 'import' && request.method === 'POST') return Response.json(await importGoogleContact(env.DB, actor, environment, path[1], await objectBody(request), request.headers.get('Idempotency-Key') || ''), { headers: { 'Cache-Control': 'no-store' } });
      if (path.length === 3 && request.method === 'POST') return Response.json(await startGoogleContactsDownload(env.DB, actor, environment, path[1], await objectBody(request), env.GOOGLE_CONTACTS_QUEUE), { headers: { 'Cache-Control': 'no-store' } });
      if (path.length === 4 && path[3] === 'step' && request.method === 'POST') {
        const body = await objectBody(request);
        const review = await reviewGoogleContacts(env.DB, actor, path[1]);
        if (!review.run || body.run_id !== review.run.id || review.run.status !== 'active') throw new ProviderConnectionError('Refresh the current download before continuing.');
        return Response.json(await advanceGoogleContactsDownload(env.DB, environment, { kind: 'google-contacts', version: 1, workspaceId: actor.workspaceId, connectionId: path[1], runId: review.run.id }), { headers: { 'Cache-Control': 'no-store' } });
      }
      return Response.json({ error: 'Contact download route not found.' }, { status: 404 });
    }
    if (callback) {
      const parameters = new URL(request.url).searchParams;
      callbackPage = connectionPage(await googleAuthorizationPurpose(env.DB, actor, parameters));
      const connection = await completeGoogleConnection(env.DB, actor, environment, parameters);
      return new Response(null, { status: 303, headers: { Location: connectionPage(connection.purpose) + '?result=connected', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
    }
    if (path.length === 2 && request.method === 'DELETE') {
      if (request.headers.get('origin') !== new URL(environment.BETTER_AUTH_URL || '').origin) throw new ProviderConnectionError('Disconnect from this Everclose app.', 403);
      const body = await objectBody(request);
      return Response.json(await disconnectGoogleConnection(env.DB, actor, environment, path[1], body.expected_revision));
    }
    return Response.json({ error: 'Connection route not found.' }, { status: 404 });
  } catch (error) {
    if (callback) return new Response(null, { status: 303, headers: { Location: callbackPage + '?result=failed', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
    if (error instanceof ContactMethodError || error instanceof ContactRevisionError || error instanceof GmailChoicesError) return Response.json({ error: error.message }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    if (error instanceof ProviderConnectionError || error instanceof RequestBodyError || error instanceof ProviderSourceError || error instanceof IdempotencyError) return Response.json({ error: error.message }, { status: error.status, headers: { 'Cache-Control': 'no-store', ...(error.status === 503 ? { 'Retry-After': '2' } : {}) } });
    if (/PROVIDER_LINK_LIMIT|CONTACT_SYNC_LIMIT/u.test(String(error))) return Response.json({ error: 'This person has reached the saved-source size limit. Choose fewer fields or unlink an unused source.', }, { status: 413 });
    const recovery = recoveryErrorResponse(error); if (recovery) return recovery;
    // Do not serialize provider responses or credential-bearing exceptions into logs.
    console.error('cloud.provider_connection.failed');
    return Response.json({ error: 'This connection changed or could not be saved. Refresh and try again.' }, { status: 409 });
  }
}
