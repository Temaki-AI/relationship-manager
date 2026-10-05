import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { accountScope, type NativeAccount } from '../../packages/domain/src/devices.ts';

const repository = fileURLToPath(new URL('../../', import.meta.url));
export async function createMobileHarness(account: NativeAccount, sqlite = new Database(':memory:')) {
  const cache = new Map<string, { exports: Record<string, unknown> }>();
  function load(filename: string): Record<string, unknown> {
    if (!path.extname(filename)) filename += '.ts';
    const existing = cache.get(filename);
    if (existing) return existing.exports;
    const loadedModule = { exports: {} as Record<string, unknown> }; cache.set(filename, loadedModule);
    const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new Function('require', 'module', 'exports', code)((name: string) => {
      if (name === 'expo-crypto') return { randomUUID: () => crypto.randomUUID(), CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
        digestStringAsync: async (algorithm: string, value: string) => { if (algorithm !== 'SHA-256') throw new Error('Unexpected digest algorithm'); return createHash('sha256').update(value, 'utf8').digest('hex'); } };
      if (name.startsWith('@/')) return load(path.join(repository, 'apps/mobile/src', name.slice(2)));
      if (name.startsWith('.')) return load(path.resolve(path.dirname(filename), name));
      throw new Error(`Unexpected native test dependency: ${name}`);
    }, loadedModule, loadedModule.exports);
    return loadedModule.exports;
  }
  const faults: { sqlContains?: string } = {};
  const db = {
    async getFirstAsync(sql: string, ...values: Array<string | number | null>) { return sqlite.prepare(sql).get(...values) ?? null; },
    async getAllAsync(sql: string, ...values: Array<string | number | null>) { return sqlite.prepare(sql).all(...values); },
    async execAsync(sql: string) { sqlite.exec(sql); },
    async runAsync(sql: string, ...values: Array<string | number | null>) {
      if (faults.sqlContains && sql.includes(faults.sqlContains)) throw new Error('Simulated local database write failure');
      return sqlite.prepare(sql).run(...values);
    },
    async withExclusiveTransactionAsync(task: (db: typeof typedDb) => Promise<void>) {
      sqlite.exec('BEGIN IMMEDIATE');
      try { await task(typedDb); sqlite.exec('COMMIT'); }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  const typedDb = db as unknown as Parameters<typeof import('../../apps/mobile/src/data/database.ts').migrateDatabase>[0];
  const database = load(path.join(repository, 'apps/mobile/src/data/database.ts')) as typeof import('../../apps/mobile/src/data/database.ts');
  const contacts = load(path.join(repository, 'apps/mobile/src/data/contacts.ts')) as typeof import('../../apps/mobile/src/data/contacts.ts');
  const contactDrafts = load(path.join(repository, 'apps/mobile/src/data/contact-drafts.ts')) as typeof import('../../apps/mobile/src/data/contact-drafts.ts');
  const journalDrafts = load(path.join(repository, 'apps/mobile/src/data/journal-drafts.ts')) as typeof import('../../apps/mobile/src/data/journal-drafts.ts');
  const photos = load(path.join(repository, 'apps/mobile/src/data/contact-photos.ts')) as typeof import('../../apps/mobile/src/data/contact-photos.ts');
  const photoOutbox = load(path.join(repository, 'apps/mobile/src/data/contact-photo-outbox.ts')) as typeof import('../../apps/mobile/src/data/contact-photo-outbox.ts');
  const reminders = load(path.join(repository, 'apps/mobile/src/data/reminders.ts')) as typeof import('../../apps/mobile/src/data/reminders.ts');
  const today = load(path.join(repository, 'apps/mobile/src/data/today.ts')) as typeof import('../../apps/mobile/src/data/today.ts');
  const context = load(path.join(repository, 'apps/mobile/src/data/context.ts')) as typeof import('../../apps/mobile/src/data/context.ts');
  const deviceContacts = load(path.join(repository, 'apps/mobile/src/data/device-contacts.ts')) as typeof import('../../apps/mobile/src/data/device-contacts');
  const deviceSourceSync = load(path.join(repository, 'apps/mobile/src/data/device-source-sync.ts')) as typeof import('../../apps/mobile/src/data/device-source-sync');
  const deviceReconciliation = load(path.join(repository, 'apps/mobile/src/data/device-contact-reconciliation.ts')) as typeof import('../../apps/mobile/src/data/device-contact-reconciliation');
  const methods = load(path.join(repository, 'apps/mobile/src/data/contact-methods.ts')) as typeof import('../../apps/mobile/src/data/contact-methods.ts');
  const calendarEvents = load(path.join(repository, 'apps/mobile/src/data/calendar-events.ts')) as typeof import('../../apps/mobile/src/data/calendar-events.ts');
  const calendarLinks = load(path.join(repository, 'apps/mobile/src/data/calendar-event-links.ts')) as typeof import('../../apps/mobile/src/data/calendar-event-links.ts');
  const appleCalendar = load(path.join(repository, 'apps/mobile/src/data/apple-calendar.ts')) as typeof import('../../apps/mobile/src/data/apple-calendar.ts');
  const gmailContext = load(path.join(repository, 'apps/mobile/src/data/gmail-context.ts')) as typeof import('../../apps/mobile/src/data/gmail-context.ts');
  const sync = load(path.join(repository, 'apps/mobile/src/data/cloud-sync.ts')) as typeof import('../../apps/mobile/src/data/cloud-sync.ts');
  const queue = load(path.join(repository, 'apps/mobile/src/data/sync-queue.ts')) as typeof import('../../apps/mobile/src/data/sync-queue.ts');
  await database.migrateDatabase(typedDb);
  await database.bindDatabaseAccount(typedDb, accountScope(account));
  await deviceSourceSync.bindDeviceInstallation(typedDb, await deviceSourceSync.installationId(typedDb) ?? crypto.randomUUID());
  return { db: typedDb, sqlite, faults, database, contacts, contactDrafts, journalDrafts, photos, photoOutbox, reminders, today, context, methods, deviceContacts, deviceSourceSync, deviceReconciliation, calendarEvents, calendarLinks, appleCalendar, gmailContext, sync, queue, close: () => sqlite.close() };
}
