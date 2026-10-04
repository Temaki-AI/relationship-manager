import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import ts from 'typescript';
import { memoryR2 } from './memory-r2.ts';
import type { SnapshotCaptureJob } from '../../lib/cloud/snapshot-capture.ts';
import type { SnapshotReadJob } from '../../lib/cloud/snapshot-reader.ts';
import type { SnapshotRestorePreparation } from '../../lib/cloud/snapshot-restore-preparation.ts';
import type { RecoveryQueueMessage } from '../../lib/cloud/large-recovery-queue.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../package.json', import.meta.url));

function sqliteBinding(sqlite: Database.Database) {
  return {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let values: unknown[] = [];
      const execute = () => {
        if (statement.reader) return { success: true, results: statement.all(...values), meta: { changes: 0 } };
        const result = statement.run(...values);
        return { success: true, results: [], meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
      };
      return {
        bind(...args: unknown[]) { values = args; return this; },
        async first() { return statement.get(...values) || null; },
        async all() { return execute(); },
        async run() { return execute(); },
        execute,
      };
    },
    async batch(statements: Array<{ execute: () => unknown }>) {
      return sqlite.transaction(() => statements.map((statement) => statement.execute()))();
    },
  };
}

export async function createCloudHarness() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  let runtime: { dispose: () => Promise<void> } | undefined;
  let db;
  let bucket;
  if (process.env.CLOUD_TEST_RUNTIME === 'workerd') {
    const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
    const mf = new Miniflare(convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("test"); } }',
      d1Databases: ['DB'],
      r2Buckets: ['PRIVATE_ASSETS'],
    }));
    runtime = mf;
    db = await mf.getD1Database('DB');
    bucket = await mf.getR2Bucket('PRIVATE_ASSETS');
    try {
      for (const filename of readdirSync(path.join(root, 'drizzle')).filter((name) => name.endsWith('.sql')).sort()) {
        for (const sql of readFileSync(path.join(root, 'drizzle', filename), 'utf8').split('--> statement-breakpoint')) {
          if (sql.trim()) await db.prepare(sql).run();
        }
      }
    } catch (error) {
      await mf.dispose(); sqlite.close(); throw error;
    }
  } else {
    for (const filename of readdirSync(path.join(root, 'drizzle')).filter((name) => name.endsWith('.sql')).sort()) {
      sqlite.exec(readFileSync(path.join(root, 'drizzle', filename), 'utf8'));
    }
    db = sqliteBinding(sqlite);
    bucket = memoryR2();
  }
  const faults: { failPut?: boolean; failGet?: boolean; failDelete?: boolean; failQueueSend?: boolean; afterPut?: (key: string) => Promise<void>; afterComplete?: () => Promise<void>; listPageSize?: number } = {};
  const queueMessages: Array<{ body: RecoveryQueueMessage; attempts: number }> = [];
  const deadLetterMessages: Array<{ body: RecoveryQueueMessage; attempts: number }> = [];
  const recoveryQueue = {
    async send(body: RecoveryQueueMessage) {
      if (faults.failQueueSend) throw new Error('Simulated queue outage');
      queueMessages.push({ body, attempts: 1 });
    },
  };
  const wrapUpload = (upload: Awaited<ReturnType<typeof bucket.createMultipartUpload>>) => ({
    key: upload.key, uploadId: upload.uploadId,
    uploadPart: (partNumber: number, value: Uint8Array) => upload.uploadPart(partNumber, value),
    abort: () => upload.abort(),
    async complete(parts: Array<{ partNumber: number; etag: string }>) {
      const result = await upload.complete(parts);
      await faults.afterComplete?.();
      return result;
    },
  });
  const assets = {
    async put(key: string, value: Uint8Array | ArrayBuffer | string, options?: { customMetadata?: Record<string, string> }) {
      if (faults.failPut) throw new Error('Simulated object-storage outage');
      const result = await bucket.put(key, value, options);
      await faults.afterPut?.(key);
      return result;
    },
    async get(key: string) { if (faults.failGet) throw new Error('Simulated object-storage read outage'); return bucket.get(key); },
    head: (key: string) => bucket.head(key),
    async createMultipartUpload(key: string) { return wrapUpload(await bucket.createMultipartUpload(key)); },
    resumeMultipartUpload: (key: string, uploadId: string) => wrapUpload(bucket.resumeMultipartUpload(key, uploadId)),
    async delete(keys: string | string[]) { if (faults.failDelete) throw new Error('Simulated deletion outage'); await bucket.delete(keys); },
    list: (options: { prefix?: string; limit?: number; cursor?: string }) => bucket.list({ ...options, limit: Math.min(options.limit || 1000, faults.listPageSize || 1000) }),
  };
  await db.prepare("INSERT INTO workspaces(id, name) VALUES ('test', 'Test'), ('other', 'Other')").run();
  const emailEnv: Record<string, unknown> = {
    DB: db, PRIVATE_ASSETS: assets, LARGE_RECOVERY_QUEUE: recoveryQueue, EMAIL_DELIVERY_ENABLED: 'false',
    EMAIL_FROM: 'alerts@everclosecrm.com', BETTER_AUTH_URL: 'https://everclosecrm.com',
  };
  const cache = new Map<string, { exports: Record<string, unknown> }>();
  function load(filename: string): Record<string, unknown> {
    if (cache.has(filename)) return cache.get(filename)!.exports;
    const loadedModule = { exports: {} };
    cache.set(filename, loadedModule);
    const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    function localRequire(name: string): unknown {
      if (name === '@opennextjs/cloudflare') return { getCloudflareContext: () => ({ env: emailEnv }) };
      if (name.startsWith('@/') || name.startsWith('.')) {
        let resolved = name.startsWith('@/') ? path.join(root, name.slice(2)) : path.resolve(path.dirname(filename), name);
        if (!path.extname(resolved)) resolved += '.ts';
        return load(resolved);
      }
      return require(name);
    }
    new Function('require', 'module', 'exports', compiled)(localRequire, loadedModule, loadedModule.exports);
    return loadedModule.exports;
  }
  type Handler = (request: Request, workspaceId: string, path: string[]) => Promise<Response>;
  const contactApi = load(path.join(root, 'lib/cloud/contact-api.ts'));
  const sourceApi = load(path.join(root, 'lib/cloud/contact-source-api.ts'));
  const syncApi = load(path.join(root, 'lib/cloud/sync-api.ts'));
  const syncV2Api = load(path.join(root, 'lib/cloud/sync-v2-api.ts'));
  const deviceApi = load(path.join(root, 'lib/cloud/device-api.ts'));
  const deviceSourceApi = load(path.join(root, 'lib/cloud/device-source-api.ts'));
  const duplicateMergeApi = load(path.join(root, 'lib/cloud/duplicate-merge-api.ts'));
  const duplicateReviewApi = load(path.join(root, 'lib/cloud/duplicate-review-api.ts'));
  const enrichmentApi = load(path.join(root, 'lib/cloud/enrich-api.ts'));
  const contactHandler = contactApi.handleCloudContacts as Handler;
  const coreHandler = load(path.join(root, 'lib/cloud/core-api.ts')).handleCloudCore as (request: Request, workspaceId: string, path: string[], userId?: string) => Promise<Response>;
  const backupApi = load(path.join(root, 'lib/cloud/backup-api.ts'));
  const recoveryContract = load(path.join(root, 'lib/cloud/recovery-contract.ts'));
  const importApi = load(path.join(root, 'lib/cloud/import-api.ts'));
  const portableApi = load(path.join(root, 'lib/cloud/portable-api.ts'));
  const exportJobsApi = load(path.join(root, 'lib/cloud/export-jobs.ts'));
  const todayApi = load(path.join(root, 'lib/cloud/today-api.ts'));
  const reminderEmailApi = load(path.join(root, 'lib/cloud/reminder-email-api.ts'));
  const reminderEmailDelivery = load(path.join(root, 'lib/cloud/reminder-email-delivery.ts'));
  const birthdayEmailDelivery = load(path.join(root, 'lib/cloud/birthday-email-delivery.ts'));
  const snapshotCapture = load(path.join(root, 'lib/cloud/snapshot-capture.ts'));
  const snapshotManifest = load(path.join(root, 'lib/cloud/snapshot-manifest.ts'));
  const snapshotReader = load(path.join(root, 'lib/cloud/snapshot-reader.ts'));
  const snapshotRestorePreparation = load(path.join(root, 'lib/cloud/snapshot-restore-preparation.ts'));
  const snapshotRestoreApply = load(path.join(root, 'lib/cloud/snapshot-restore-apply.ts'));
  const largeRecoveryApi = load(path.join(root, 'lib/cloud/large-recovery-api.ts'));
  const largeRecoveryQueue = load(path.join(root, 'lib/cloud/large-recovery-queue.ts'));
  const automaticBackup = load(path.join(root, 'lib/cloud/automatic-backup.ts'));
  const snapshotCleanup = load(path.join(root, 'lib/cloud/snapshot-cleanup.ts'));
  async function call(endpoint: string, options: { method?: string; body?: unknown; form?: FormData; key?: string | null; workspace?: string; role?: string; lifecycle?: string; headers?: Record<string, string> } = {}) {
    if (endpoint === 'sources/linkedin' && options.method === 'POST' && options.body && typeof options.body === 'object' && !('expected_epoch' in options.body)) {
      const state = await db.prepare('SELECT epoch FROM workspace_sync_state WHERE workspace_id = ?').bind(options.workspace || 'test').first();
      options = { ...options, body: { ...options.body, expected_epoch: state.epoch } };
    }
    const parts = endpoint.split('?')[0].split('/');
    const headers = new Headers({ 'Content-Type': 'application/json', ...options.headers });
    if (options.form) headers.delete('Content-Type');
    if (options.key !== null) headers.set('Idempotency-Key', options.key || crypto.randomUUID());
    const request = new Request(`https://test.invalid/api/${endpoint}`, {
      method: options.method || 'GET', headers,
      body: options.form || (options.body === undefined ? undefined : JSON.stringify(options.body)),
    });
    let response;
    if (parts.join('/') === 'v1/calendar-event-links/push' || parts.join('/') === 'v1/device-sources/push' || parts[0] === 'contacts' && parts[2] === 'device-sources') {
      const authorization = headers.get('authorization');
      let actor: unknown = { userId: 'owner', workspaceId: options.workspace || 'test', authMethod: 'web', lifecycle: 'active' };
      if (authorization) {
        try { actor = { ...await (deviceApi.requireDeviceWorkspace as (db: typeof db, h: Headers) => Promise<unknown>)(db, headers), authMethod: 'device' }; }
        catch { return { status: 401, headers: new Headers(), body: { error: 'Device session revoked.' } }; }
      }
      const handler = parts.join('/') === 'v1/calendar-event-links/push'
        ? load(path.join(root, 'lib/cloud/calendar-event-link-api.ts')).handleCalendarEventLinks : deviceSourceApi.handleDeviceSources;
      response = await (handler as (r: Request, a: unknown, p: string[]) => Promise<Response>)(request, actor, parts);
    } else if (parts[0] === 'calendar' && parts[1] === 'events') {
      response = await (load(path.join(root, 'lib/cloud/calendar-event-links.ts')).handleSavedCalendarEvents as (r: Request, a: unknown, p: string[]) => Promise<Response>)(request, { userId: 'owner', workspaceId: options.workspace || 'test', lifecycle: 'active', authMethod: 'web' }, parts);
    } else if (parts[0] === 'sources' || parts[0] === 'contacts' && parts[2] === 'sources') {
      response = await (sourceApi.handleCloudContactSources as Handler)(request, options.workspace || 'test', parts);
    } else if (parts[0] === 'v1' && parts[1] === 'sync') {
      response = await (syncApi.handleCloudSync as Handler)(request, options.workspace || 'test', parts);
    } else if (parts[0] === 'v2' && parts[1] === 'sync') {
      response = await (syncV2Api.handleCloudSyncV2 as Handler)(request, options.workspace || 'test', parts);
    } else if (parts[0] === 'v4' && parts[1] === 'sync') {
      response = await (syncV2Api.handleCloudSyncV4 as Handler)(request, options.workspace || 'test', parts);
    } else if (parts[0] === 'v3' && parts[1] === 'sync') {
      response = await (syncV2Api.handleCloudSyncV3 as Handler)(request, options.workspace || 'test', parts);
    } else if (parts[0] === 'today' && parts[1] === 'snooze') {
      response = await (todayApi.handleCloudTodaySnooze as (r: Request, w: string) => Promise<Response>)(request, options.workspace || 'test');
    } else if (parts[0] === 'enrich') {
      response = await (enrichmentApi.handleCloudEnrich as (r: Request) => Promise<Response>)(request);
    } else if (parts[0] === 'import') {
      if (parts[1] === 'jobs') response = await (importApi.handleCloudImportJobs as (r: Request, w: string, id?: string, action?: string) => Promise<Response>)(request, options.workspace || 'test', parts[2], parts[3]);
      else response = await (importApi.createCloudImport as (r: Request, w: string, format: string) => Promise<Response>)(request, options.workspace || 'test', parts[1]);
    } else if (parts[0] === 'settings') {
      if (parts[1] === 'large-recovery') {
        response = await (largeRecoveryApi.handleCloudLargeRecovery as
          (r: Request, w: string, role: string, lifecycle: string, id?: string, action?: string) => Promise<Response>)(
            request, options.workspace || 'test', options.role || 'owner', options.lifecycle || 'active', parts[2], parts[3]);
      } else {
        const handler = backupApi[parts[1] === 'backups' ? 'handleCloudBackups' : parts[1] === 'restore' ? 'handleCloudRestore' : 'handleCloudErasure'] as (r: Request, w: string, f?: string) => Promise<Response>;
        response = await handler(request, options.workspace || 'test', parts[2]);
      }
    } else if (parts[0] === 'export') {
      response = parts[1] === 'jobs'
        ? await (exportJobsApi.handleCloudExportJobs as (r: Request, w: string, id?: string, action?: string) => Promise<Response>)(request, options.workspace || 'test', parts[2], parts[3])
        : await (portableApi.handleCloudExport as (w: string, f: 'csv' | 'vcard') => Promise<Response>)(options.workspace || 'test', parts[1] as 'csv' | 'vcard');
    } else if (parts[0] === 'groups' && parts[1] === 'tags') {
      response = await (contactApi.handleCloudTagGroups as
        (r: Request, w: string, path: string[]) => Promise<Response>)(request, options.workspace || 'test', parts);
    } else if (parts[0] === 'contacts' && parts[1] === 'duplicates' && request.method === 'POST') {
      response = await (duplicateMergeApi.handleCloudDuplicateMerge as
        (r: Request, w: string) => Promise<Response>)(request, options.workspace || 'test');
    } else if (parts[0] === 'contacts' && parts[1] === 'duplicates') {
      response = await (duplicateReviewApi.handleCloudDuplicateReview as
        (r: Request, w: string) => Promise<Response>)(request, options.workspace || 'test');
    } else response = parts[0] === 'contacts' ? await contactHandler(request, options.workspace || 'test', parts) : await coreHandler(request, options.workspace || 'test', parts, 'owner');
    return { status: response.status, headers: response.headers, body: response.headers.get('Content-Type')?.includes('application/json') ? await response.json() : Array.from(new Uint8Array(await response.arrayBuffer())) };
  }
  const cleanupExpiredExports = exportJobsApi.cleanupExpiredExportJobs as (
    db: typeof db, bucket: typeof assets, now?: Date
  ) => Promise<{ attempted: number; removed: number; pending: number; failed: number }>;
  return { db, assets, faults, call, emailEnv, queueMessages, deadLetterMessages,
    providers: load(path.join(root, 'lib/cloud/provider-connections.ts')) as typeof import('../../lib/cloud/provider-connections'),
    googleCalendarResources: load(path.join(root, 'lib/cloud/google-calendar-resources.ts')) as typeof import('../../lib/cloud/google-calendar-resources'),
    googleCalendars: load(path.join(root, 'lib/cloud/google-calendars.ts')) as typeof import('../../lib/cloud/google-calendars'),
    googleEvents: load(path.join(root, 'lib/cloud/google-calendar-events.ts')) as typeof import('../../lib/cloud/google-calendar-events'),
    eventDownloads: load(path.join(root, 'lib/cloud/google-event-downloads.ts')) as typeof import('../../lib/cloud/google-event-downloads'),
    eventJobs: load(path.join(root, 'lib/cloud/google-event-jobs.ts')) as typeof import('../../lib/cloud/google-event-jobs'),
    planObservations: load(path.join(root, 'lib/cloud/calendar-plan-observations.ts')) as typeof import('../../lib/cloud/calendar-plan-observations'),
    planPublications: load(path.join(root, 'lib/cloud/calendar-plan-publications.ts')) as typeof import('../../lib/cloud/calendar-plan-publications'),
    publicationDraft: load(path.join(root, 'packages/domain/src/calendar-publication.ts')) as typeof import('../../packages/domain/src/calendar-publication'),
    ownedCalendar: load(path.join(root, 'lib/cloud/google-owned-calendar.ts')) as typeof import('../../lib/cloud/google-owned-calendar'),
    calendarFacts: load(path.join(root, 'packages/domain/src/calendar-events.ts')) as typeof import('../../packages/domain/src/calendar-events'),
    eventLinks: load(path.join(root, 'lib/cloud/calendar-event-links.ts')) as typeof import('../../lib/cloud/calendar-event-links'),
    deviceSources: deviceSourceApi as typeof import('../../lib/cloud/device-source-api'),
    providerVault: load(path.join(root, 'lib/cloud/provider-vault.ts')) as typeof import('../../lib/cloud/provider-vault'),
    providerApi: load(path.join(root, 'lib/cloud/provider-connection-api.ts')) as typeof import('../../lib/cloud/provider-connection-api'),
    googleContacts: load(path.join(root, 'lib/cloud/google-contacts.ts')) as typeof import('../../lib/cloud/google-contacts'),
    contactDownloads: load(path.join(root, 'lib/cloud/google-contact-downloads.ts')) as typeof import('../../lib/cloud/google-contact-downloads'),
    contactImports: load(path.join(root, 'lib/cloud/google-contact-imports.ts')) as typeof import('../../lib/cloud/google-contact-imports'),
    fieldControls: load(path.join(root, 'lib/cloud/provider-field-controls.ts')) as typeof import('../../lib/cloud/provider-field-controls'),
    providerSourceApi: load(path.join(root, 'lib/cloud/provider-source-api.ts')) as typeof import('../../lib/cloud/provider-source-api'),
    async authorizeDevice(body: unknown, options: { userId?: string; workspaceId?: string; authMethod?: 'web' | 'device'; origin?: string } = {}) {
      const request = new Request('https://test.invalid/api/v1/devices/authorize', { method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: options.origin || String(emailEnv.BETTER_AUTH_URL) }, body: JSON.stringify(body) });
      try { return await (deviceApi.authorizeDevice as (r: Request, a: unknown, d: typeof db) => Promise<Response>)(request,
        { userId: options.userId || 'owner', workspaceId: options.workspaceId || 'test', lifecycle: 'active', authMethod: options.authMethod || 'web' }, db); }
      catch (error) { return (deviceApi.deviceErrorResponse as (e: unknown) => Response)(error); }
    },
    async exchangeDevice(body: unknown) {
      const request = new Request('https://test.invalid/api/auth/device/exchange', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      try { return await (deviceApi.exchangeDeviceCode as (r: Request, d: typeof db) => Promise<Response>)(request, db); }
      catch (error) { return (deviceApi.deviceErrorResponse as (e: unknown) => Response)(error); }
    },
    deviceWorkspace: (token: string) => (deviceApi.requireDeviceWorkspace as (d: typeof db, h: Headers) => Promise<{
      deviceId: string; userId: string; workspaceId: string; lifecycle: string; role: string;
    }>)(db, new Headers({ Authorization: `Bearer ${token}` })),
    deviceRoute: (request: Request, actor: unknown, path: string[]) => (deviceApi.handleCloudDevices as
      (r: Request, a: unknown, p: string[]) => Promise<Response>)(request, actor, path),
    async processNextRestoreMessage() {
      const queued = queueMessages.shift();
      if (!queued) return null;
      let outcome: 'ack' | 'retry' | null = null;
      await (largeRecoveryQueue.processCloudRestoreMessage as
        (message: unknown, env: unknown) => Promise<void>)({
        body: queued.body, attempts: queued.attempts,
        ack() { outcome = 'ack'; },
        retry() {
          outcome = 'retry';
          if (queued.attempts >= 10) deadLetterMessages.push(queued);
          else queueMessages.push({ ...queued, attempts: queued.attempts + 1 });
        },
      }, emailEnv);
      return { ...queued, outcome };
    },
    reconcileRestoreQueue: (now?: Date) => (largeRecoveryQueue.reconcileStalledCloudRestoreJobs as
      (db: unknown, queue: unknown, now?: Date) => Promise<number>)(db, recoveryQueue, now),
    beginCapture: (workspaceId = 'test') => (snapshotCapture.beginCloudSnapshotCapture as
      (workspaceId: string, env: unknown) => Promise<SnapshotCaptureJob>)(workspaceId, emailEnv),
    advanceCapture: (id: string, workspaceId = 'test') => (snapshotCapture.advanceCloudSnapshotCapture as
      (workspaceId: string, id: string, env: unknown) => Promise<SnapshotCaptureJob>)(workspaceId, id, emailEnv),
    advanceCaptureVerification: (id: string, workspaceId = 'test') => (snapshotManifest.advanceCloudSnapshotVerification as
      (workspaceId: string, id: string, env: unknown) => Promise<SnapshotCaptureJob>)(workspaceId, id, emailEnv),
    beginSnapshotRead: (captureJobId: string, workspaceId = 'test') => (snapshotReader.beginCloudSnapshotRead as
      (workspaceId: string, captureJobId: string, env: unknown) => Promise<SnapshotReadJob>)(workspaceId, captureJobId, emailEnv),
    advanceSnapshotRead: (id: string, workspaceId = 'test') => (snapshotReader.advanceCloudSnapshotRead as
      (workspaceId: string, id: string, env: unknown) => Promise<SnapshotReadJob>)(workspaceId, id, emailEnv),
    discardSnapshotRead: (id: string, workspaceId = 'test') => (snapshotReader.discardCloudSnapshotRead as
      (workspaceId: string, id: string, db: unknown) => Promise<void>)(workspaceId, id, db),
    beginRestorePreparation: (targetId: string, workspaceId = 'test') =>
      (snapshotRestorePreparation.beginCloudSnapshotRestorePreparation as
        (workspaceId: string, targetId: string, env: unknown) => Promise<SnapshotRestorePreparation>)(workspaceId, targetId, emailEnv),
    advanceRestorePreparation: (id: string, workspaceId = 'test') =>
      (snapshotRestorePreparation.advanceCloudSnapshotRestorePreparation as
        (workspaceId: string, id: string, env: unknown) => Promise<SnapshotRestorePreparation>)(workspaceId, id, emailEnv),
    cancelRestorePreparation: (id: string, workspaceId = 'test') =>
      (snapshotRestorePreparation.cancelCloudSnapshotRestorePreparation as
        (workspaceId: string, id: string, db: unknown) => Promise<void>)(workspaceId, id, db),
    beginRestoreApply: (id: string, workspaceId = 'test') =>
      (snapshotRestoreApply.beginCloudSnapshotRestoreApply as
        (workspaceId: string, id: string, env: unknown) => Promise<SnapshotRestorePreparation>)(workspaceId, id, emailEnv),
    beginRestoreRollback: (id: string, workspaceId = 'test') =>
      (snapshotRestoreApply.beginCloudSnapshotRestoreRollback as
        (workspaceId: string, id: string, env: unknown) => Promise<SnapshotRestorePreparation>)(workspaceId, id, emailEnv),
    advanceRestoreDeletion: (id: string, workspaceId = 'test') =>
      (snapshotRestoreApply.advanceCloudSnapshotRestoreDeletion as
        (workspaceId: string, id: string, db: unknown) => Promise<SnapshotRestorePreparation>)(workspaceId, id, db),
    advanceRestoreWriting: (id: string, workspaceId = 'test') =>
      (snapshotRestoreApply.advanceCloudSnapshotRestoreWriting as
        (workspaceId: string, id: string, env: unknown) => Promise<SnapshotRestorePreparation>)(workspaceId, id, emailEnv),
    advanceRestoreDateRepair: (id: string, workspaceId = 'test') =>
      (snapshotRestoreApply.advanceCloudSnapshotRestoreDateRepair as
        (workspaceId: string, id: string, env: unknown) => Promise<SnapshotRestorePreparation>)(workspaceId, id, emailEnv),
    advanceRestoreVerification: (id: string, workspaceId = 'test') =>
      (snapshotRestoreApply.advanceCloudSnapshotRestoreVerification as
        (workspaceId: string, id: string, env: unknown) => Promise<SnapshotRestorePreparation>)(workspaceId, id, emailEnv),
    discardCapture: (id: string, workspaceId = 'test') => (snapshotCapture.discardCloudSnapshotCapture as
      (workspaceId: string, id: string, env: unknown) => Promise<{ pending: boolean }>)(workspaceId, id, emailEnv),
    runAutomaticBackups: (now?: Date) => (automaticBackup.runAutomaticCloudBackups as (db: typeof db, assets: typeof assets, now?: Date) => Promise<{ claimed: number; created: number; failed: number; oversized: number }>)(db, assets, now),
    cleanupStaleBackups: (now?: Date) => (automaticBackup.cleanupStaleCloudBackupArtifacts as (db: typeof db, assets: typeof assets, now?: Date) => Promise<{ releasedPins: number; attempted: number; removed: number; failed: number }>)(db, assets, now),
    cleanupStaleSnapshots: (now?: Date) => (snapshotCleanup.cleanupStaleCloudSnapshotArtifacts as
      (db: typeof db, assets: typeof assets, now?: Date) => Promise<{ terminalRestoreJobsRemoved: number; restorePreparationsRemoved: number; readJobsRemoved: number; capturesInvalidated: number; captureJobsAttempted: number; captureJobsRemoved: number; pending: number; failed: number }>)(db, assets, now),
    automaticBackupStatus: (workspaceId: string, enabled: boolean, now?: Date) => (automaticBackup.readAutomaticBackupStatus as (db: typeof db, workspaceId: string, enabled: boolean, now?: Date) => Promise<{ enabled: boolean; state: string; latestBackupAt: string | null; nextBackupAt: string | null; issue: string | null }>)(db, workspaceId, enabled, now),
    emailSettings: (request: Request, workspaceId = 'test', userId = 'user-1') =>
      (reminderEmailApi.handleReminderEmailPreferences as (r: Request, w: string, u: string) => Promise<Response>)(request, workspaceId, userId),
    deliverEmails: (now?: Date) => (reminderEmailDelivery.deliverReminderEmails as (db: typeof db, env: unknown, now?: Date) => Promise<{ queued: number; sent: number; failed: number; quiet: number }>)(db, emailEnv, now),
    deliverBirthdayEmails: (now?: Date) => (birthdayEmailDelivery.deliverBirthdayEmails as (db: typeof db, env: unknown, now?: Date) => Promise<{ scanned: number; queued: number; sent: number; eventsSent: number; failed: number; quiet: number }>)(db, emailEnv, now),
    isQuietHour: reminderEmailDelivery.isQuietHour as (now: Date, zone: string, start: number, end: number) => boolean,
    nextAllowedEmailTime: reminderEmailDelivery.nextAllowedEmailTime as (now: Date, zone: string, start: number, end: number) => string,
    validateCloudSnapshot: recoveryContract.validateCloudSnapshot as (value: unknown, workspaceId: string) => { tables: Record<string, unknown[]> },
    cleanupExpiredExports: (now?: Date) => cleanupExpiredExports(db, assets, now),
    async close() { sqlite.close(); await runtime?.dispose(); } };
}
