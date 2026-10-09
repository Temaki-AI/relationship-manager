import { handleCloudContacts, handleCloudTagGroups } from '@/lib/cloud/contact-api';
import { handleCloudCore } from '@/lib/cloud/core-api';
import { handleCloudExport } from '@/lib/cloud/portable-api';
import { handleCloudExportJobs } from '@/lib/cloud/export-jobs';
import { handleCloudTodaySnooze } from '@/lib/cloud/today-api';
import { handleTodaySnoozeSync } from '@/lib/cloud/today-snooze-sync-api';
import { handleCalendarReservations } from '@/lib/cloud/calendar-reservation-api';
import { handleCloudBackups, handleCloudErasure, handleCloudRestore } from '@/lib/cloud/backup-api';
import { createCloudImport, handleCloudImportJobs } from '@/lib/cloud/import-api';
import { CloudAuthenticationError, CloudWorkspaceError, requireCloudWorkspace } from '@/lib/cloud/session';
import { handleReminderEmailPreferences } from '@/lib/cloud/reminder-email-api';
import { cloudWorkspaceMaintenanceResponse } from '@/lib/cloud/workspace-access';
import { handleCloudLargeRecovery } from '@/lib/cloud/large-recovery-api';
import { handleCloudEnrich } from '@/lib/cloud/enrich-api';
import { handleCloudDuplicateReview } from '@/lib/cloud/duplicate-review-api';
import { handleCloudDuplicateMerge } from '@/lib/cloud/duplicate-merge-api';
import { handleCloudSync } from '@/lib/cloud/sync-api';
import { handleCloudSyncV2, handleCloudSyncV3, handleCloudSyncV4 } from '@/lib/cloud/sync-v2-api';
import { handleCloudDevices } from '@/lib/cloud/device-api';
import { handleCloudContactSources } from '@/lib/cloud/contact-source-api';
import { handleProviderConnections } from '@/lib/cloud/provider-connection-api';
import { handleProviderSources } from '@/lib/cloud/provider-source-api';
import { handleDeviceSources } from '@/lib/cloud/device-source-api';
import { isNativeDeviceApiPath } from '@/packages/domain/src/devices';
import { handleSavedCalendarEvents } from '@/lib/cloud/calendar-event-links';
import { handleCalendarEventLinks } from '@/lib/cloud/calendar-event-link-api';
import { handleContactPhotos } from '@/lib/cloud/contact-photo-api';
import { handleGmailContext } from '@/lib/cloud/gmail-context-api';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ path: string[] }> };

async function dispatch(request: Request, context: Context) {
  try {
    const { path } = await context.params;
    const actor = await requireCloudWorkspace(request.headers, isNativeDeviceApiPath(`/api/${path.join('/')}`));
    const { workspaceId, userId, lifecycle, role } = actor;
    const maintenance = cloudWorkspaceMaintenanceResponse(lifecycle, path, request.method);
    if (maintenance) return maintenance;
    if (path.join('/') === 'v1/gmail-context') return handleGmailContext(request, actor, path);
    if (path[0] === 'v1' && path[1] === 'contact-photos') return handleContactPhotos(request, actor, path);
    if (path[0] === 'connections') return handleProviderConnections(request, actor, path);
    if (path[0] === 'calendar' && path[1] === 'events') return handleSavedCalendarEvents(request, actor, path);
    if (path.join('/') === 'v1/calendar-event-links/push') return handleCalendarEventLinks(request, actor, path);
    if (path[0] === 'contacts' && path[2] === 'provider-sources') return handleProviderSources(request, actor, path);
    if (path.join('/') === 'v1/device-sources/push' || path[0] === 'contacts' && path[2] === 'device-sources') return handleDeviceSources(request, actor, path);
    if (path[0] === 'v1' && path[1] === 'devices') return handleCloudDevices(request, actor, path);
    if (path[0] === 'v1' && path[1] === 'sync') return handleCloudSync(request, workspaceId, path);
    if (path[0] === 'v2' && path[1] === 'sync') return handleCloudSyncV2(request, workspaceId, path);
    if (path[0] === 'v4' && path[1] === 'sync') return handleCloudSyncV4(request, workspaceId, path);
    if (path[0] === 'v3' && path[1] === 'sync') return handleCloudSyncV3(request, workspaceId, path);
    if (path[0] === 'sources' || path[0] === 'contacts' && path[2] === 'sources') return handleCloudContactSources(request, workspaceId, path);
    if (path.length === 2 && path.join('/') === 'contacts/duplicates') {
      return request.method === 'POST'
        ? handleCloudDuplicateMerge(request, workspaceId)
        : handleCloudDuplicateReview(request, workspaceId);
    }
    if (path[0] === 'contacts') return handleCloudContacts(request, workspaceId, path);
    if (path.length === 1 && path[0] === 'enrich' && request.method === 'POST') return handleCloudEnrich(request);
    if (path.join('/') === 'v1/today-snoozes') return handleTodaySnoozeSync(request, actor);
    if (path.join('/') === 'v1/calendar-reservations') return handleCalendarReservations(request, actor);
    if (path.join('/') === 'today/snooze') return handleCloudTodaySnooze(request, workspaceId);
    if (path.join('/') === 'reminders/email-preferences') return handleReminderEmailPreferences(request, workspaceId, userId);
    if (path[0] === 'groups' && path[1] === 'tags') return handleCloudTagGroups(request, workspaceId, path);
    if (path[0] === 'export' && path[1] === 'jobs') return await handleCloudExportJobs(request, workspaceId, path[2], path[3]);
    if (path[0] === 'export' && path[1] === 'csv' && request.method === 'GET') return handleCloudExport(workspaceId, 'csv');
    if (path[0] === 'export' && path[1] === 'vcard' && request.method === 'GET') return handleCloudExport(workspaceId, 'vcard');
    if (path[0] === 'import' && path[1] === 'jobs') return await handleCloudImportJobs(request, workspaceId, path[2], path[3]);
    if (path[0] === 'import' && path[1] === 'csv' && request.method === 'POST') return await createCloudImport(request, workspaceId, 'csv');
    if (path[0] === 'import' && path[1] === 'vcard' && request.method === 'POST') return await createCloudImport(request, workspaceId, 'vcard');
    if (path[0] === 'settings' && path[1] === 'backups') return handleCloudBackups(request, workspaceId, path[2], role);
    if (path[0] === 'settings' && path[1] === 'large-recovery') {
      return handleCloudLargeRecovery(request, workspaceId, role, lifecycle, path[2], path[3]);
    }
    if (path.join('/') === 'settings/restore' && request.method === 'POST') return await handleCloudRestore(request, workspaceId);
    if (path.join('/') === 'settings/erase' && request.method === 'POST') return handleCloudErasure(request, workspaceId);
    return handleCloudCore(request, workspaceId, path, userId);
  } catch (error) {
    if (error instanceof CloudAuthenticationError || error instanceof CloudWorkspaceError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error('cloud.api.failed', error);
    return Response.json({ error: 'Cloud request failed.' }, { status: 500 });
  }
}

export const GET = dispatch;
export const POST = dispatch;
export const PATCH = dispatch;
export const PUT = dispatch;
export const DELETE = dispatch;
