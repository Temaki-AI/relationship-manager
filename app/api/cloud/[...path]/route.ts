import { handleCloudContacts, handleCloudTagGroups } from '@/lib/cloud/contact-api';
import { handleCloudCore } from '@/lib/cloud/core-api';
import { handleCloudExport } from '@/lib/cloud/portable-api';
import { handleCloudExportJobs } from '@/lib/cloud/export-jobs';
import { handleCloudTodaySnooze } from '@/lib/cloud/today-api';
import { handleCloudBackups, handleCloudErasure, handleCloudRestore } from '@/lib/cloud/backup-api';
import { createCloudImport, handleCloudImportJobs } from '@/lib/cloud/import-api';
import { CloudAuthenticationError, CloudWorkspaceError, requireCloudWorkspace } from '@/lib/cloud/session';
import { handleReminderEmailPreferences } from '@/lib/cloud/reminder-email-api';
import { cloudWorkspaceMaintenanceResponse } from '@/lib/cloud/workspace-access';
import { handleCloudLargeRecovery } from '@/lib/cloud/large-recovery-api';
import { handleCloudEnrich } from '@/lib/cloud/enrich-api';
import { handleCloudDuplicateReview } from '@/lib/cloud/duplicate-review-api';
import { handleCloudDuplicateMerge } from '@/lib/cloud/duplicate-merge-api';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ path: string[] }> };

async function dispatch(request: Request, context: Context) {
  try {
    const { workspaceId, userId, lifecycle, role } = await requireCloudWorkspace(request.headers);
    const { path } = await context.params;
    const maintenance = cloudWorkspaceMaintenanceResponse(lifecycle, path, request.method);
    if (maintenance) return maintenance;
    if (path.length === 2 && path.join('/') === 'contacts/duplicates') {
      return request.method === 'POST'
        ? handleCloudDuplicateMerge(request, workspaceId)
        : handleCloudDuplicateReview(request, workspaceId);
    }
    if (path[0] === 'contacts') return handleCloudContacts(request, workspaceId, path);
    if (path.length === 1 && path[0] === 'enrich' && request.method === 'POST') return handleCloudEnrich(request);
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
    return handleCloudCore(request, workspaceId, path);
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
