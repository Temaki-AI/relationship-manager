import type Database from 'better-sqlite3';
import { withDatabaseBusyRetry } from './database-initialization.ts';

const LEGACY_PLACEHOLDER_INTEGRATIONS = [
  {
    provider: 'local',
    label: 'Local CRM',
    status: 'connected',
    syncFrequencyMinutes: 15,
    metadata: JSON.stringify({ description: 'Primary local data store and migration bridge.' }),
  },
  {
    provider: 'google',
    label: 'Google Contacts, Gmail, Calendar',
    status: 'disconnected',
    syncFrequencyMinutes: 30,
    metadata: JSON.stringify({ roadmap: 'phase-2' }),
  },
  {
    provider: 'outlook',
    label: 'Microsoft 365',
    status: 'disconnected',
    syncFrequencyMinutes: 30,
    metadata: JSON.stringify({ roadmap: 'phase-2' }),
  },
  {
    provider: 'linkedin',
    label: 'LinkedIn Extension',
    status: 'attention',
    syncFrequencyMinutes: 120,
    metadata: JSON.stringify({ roadmap: 'phase-4', channel: 'browser-extension' }),
  },
  {
    provider: 'mobile',
    label: 'Mobile Capture',
    status: 'disconnected',
    syncFrequencyMinutes: 10,
    metadata: JSON.stringify({ roadmap: 'phase-4' }),
  },
] as const;

export function initializeWorkspaceFoundation(db: Database.Database): void {
  const initialize = db.transaction(() => {
    const workspace = db.prepare('SELECT id, name, plan, persona FROM workspaces ORDER BY id LIMIT 1')
      .get() as { id: number; name: string; plan: string; persona: string | null } | undefined;
    const workspaceId = workspace?.id ?? Number(db.prepare(
      'INSERT INTO workspaces (name, plan, persona) VALUES (?, ?, ?)'
    ).run('My Everclose CRM', 'local', 'private-first').lastInsertRowid);

    if (
      workspace?.name === 'Bonds HQ'
      && workspace.plan === 'premium'
      && workspace.persona === 'automation-first'
    ) {
      db.prepare('UPDATE workspaces SET name = ?, plan = ?, persona = ? WHERE id = ?')
        .run('My Everclose CRM', 'local', 'private-first', workspaceId);
    }

    db.prepare(`
      DELETE FROM sync_jobs
      WHERE workspace_id = ?
        AND provider = 'local'
        AND job_type = 'migration'
        AND status = 'success'
        AND summary = 'Initialized Bonds V2 workspace foundation'
        AND metadata = ?
    `).run(workspaceId, JSON.stringify({ version: '2.0-foundation' }));

    const deleteLegacyIntegration = db.prepare(`
      DELETE FROM integration_connections
      WHERE workspace_id = ?
        AND provider = ?
        AND label = ?
        AND status = ?
        AND account_email IS NULL
        AND sync_frequency_minutes = ?
        AND metadata = ?
    `);
    for (const integration of LEGACY_PLACEHOLDER_INTEGRATIONS) {
      deleteLegacyIntegration.run(
        workspaceId,
        integration.provider,
        integration.label,
        integration.status,
        integration.syncFrequencyMinutes,
        integration.metadata
      );
    }
  });

  withDatabaseBusyRetry(() => initialize.immediate());
}
