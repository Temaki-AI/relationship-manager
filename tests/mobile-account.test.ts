import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Database from 'better-sqlite3';
import ts from 'typescript';
import { accountScope, base64Url, DEVICE_TOKEN_PREFIX, readNativeAccount } from '../packages/domain/src/devices.ts';
import * as contactMethodStorage from '../packages/domain/src/contact-method-storage.ts';
import { isSyncUuid } from '../packages/domain/src/sync.ts';

function loadTypescript(filename: string, modules: Record<string, unknown>) {
  const loadedModule = { exports: {} as Record<string, (...args: unknown[]) => Promise<unknown>> };
  const code = ts.transpileModule(readFileSync(new URL(filename, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)((name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected test dependency: ${name}`);
    return modules[name];
  }, loadedModule, loadedModule.exports);
  return loadedModule.exports;
}

test('the Contacts installation identity is device-only, serializes first creation and survives account credential renewal', async () => {
  let stored: string | null = null, created = 0, written = 0;
  const modules = {
    'expo-secure-store': { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 17,
      async getItemAsync(key: string, options: unknown) { assert.equal(key, 'everclose.contact-installation'); assert.deepEqual(options, { keychainAccessible: 17 }); return stored; },
      async setItemAsync(key: string, value: string, options: unknown) { assert.equal(key, 'everclose.contact-installation'); assert.deepEqual(options, { keychainAccessible: 17 }); stored = value; written++; },
    },
    'expo-crypto': { randomUUID() { created++; return crypto.randomUUID(); } },
    '../../../../packages/domain/src/sync': { isSyncUuid },
  };
  const native = loadTypescript('../apps/mobile/src/native/device-installation.ts', modules);
  const ids = await Promise.all([native.deviceContactInstallation(), native.deviceContactInstallation()]);
  assert.equal(ids[0], ids[1]); assert.equal(created, 1); assert.equal(written, 1);
  const restarted = loadTypescript('../apps/mobile/src/native/device-installation.ts', modules);
  assert.equal(await restarted.deviceContactInstallation(), ids[0]); assert.equal(created, 1);
  stored = 'corrupted identity'; await assert.rejects(restarted.deviceContactInstallation(), /Unable to read/); assert.equal(created, 1);
});

test('native account identity separates users, workspaces and servers without depending on a renewable device credential', () => {
  const account = readNativeAccount({ deviceId: crypto.randomUUID(), userId: 'user', workspaceId: 'personal',
    email: 'me@example.com', name: 'Me', expiresAt: '2030-01-01T00:00:00.000Z', origin: 'https://everclosecrm.com',
    token: `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}` });
  const scope = accountScope(account);
  assert.equal(scope, accountScope({ ...account, deviceId: crypto.randomUUID(), token: `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}` }));
  assert.notEqual(scope, accountScope({ ...account, userId: 'other' }));
  assert.notEqual(scope, accountScope({ ...account, workspaceId: 'work' }));
  assert.notEqual(scope, accountScope({ ...account, origin: 'https://staging.everclosecrm.com' }));
  assert.notEqual(scope, accountScope(null));
  assert.throws(() => readNativeAccount({ ...account, token: 'broken' }), /invalid/);
  assert.throws(() => readNativeAccount({ ...account, origin: 'http://everclosecrm.com' }), /HTTPS/);
  assert.throws(() => readNativeAccount({ ...account, expiresAt: 'invalid' }), /Invalid/);
  for (let size = 0; size < 100; size++) {
    const bytes = randomBytes(size);
    assert.equal(base64Url(bytes), bytes.toString('base64url'));
  }
});

test('native database ownership rejects a different account even when both try to bind an empty cache concurrently', async () => {
  const sqlite = new Database(':memory:');
  try {
    const schema = loadTypescript('../apps/mobile/src/data/schema.ts', { '../../../../packages/domain/src/contact-method-storage.ts': contactMethodStorage });
    const data = loadTypescript('../apps/mobile/src/data/database.ts', { './schema': schema });
    sqlite.exec(String(schema.MOBILE_SCHEMA_SQL));
    const db = {
      async getFirstAsync(sql: string) { return sqlite.prepare(sql).get(); },
      async runAsync(sql: string, ...values: Array<string | number>) { return sqlite.prepare(sql).run(...values); },
    };
    const results = await Promise.allSettled([data.bindDatabaseAccount(db, 'account-a'), data.bindDatabaseAccount(db, 'account-b')]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.equal((sqlite.prepare("SELECT value FROM app_metadata WHERE key = 'account-scope'").get() as { value: string }).value, 'account-a');
    await assert.rejects(data.bindDatabaseAccount(db, 'account-b'), /another account/);
    await data.bindDatabaseAccount(db, 'account-a');
  } finally { sqlite.close(); }
});

test('notifications omit personal lock-screen content and discard a schedule that finishes after account switching', async () => {
  let releaseSchedule: (() => void) | undefined;
  let scheduledContent: Record<string, unknown> | undefined;
  const cancelled: string[] = [];
  let cleared = 0;
  const notifications = loadTypescript('../apps/mobile/src/native/notifications.ts', {
    'expo-notifications': {
      setNotificationHandler() {},
      async cancelAllScheduledNotificationsAsync() { cleared++; },
      async dismissAllNotificationsAsync() {}, async setBadgeCountAsync() {},
      async getPermissionsAsync() { return { status: 'granted' }; },
      async requestPermissionsAsync() { return { status: 'granted' }; },
      SchedulableTriggerInputTypes: { DATE: 'date' },
      async scheduleNotificationAsync({ content }: { content: Record<string, unknown> }) {
        scheduledContent = content;
        await new Promise<void>((resolve) => { releaseSchedule = resolve; });
        return 'delayed-old-account';
      },
      async cancelScheduledNotificationAsync(id: string) { cancelled.push(id); },
    },
  });
  await notifications.selectNotificationAccount('account-a');
  const old = notifications.scheduleReminderNotification({ accountScope: 'account-a', contactName: 'Private Name',
    reminderTitle: 'Sensitive topic', contactId: crypto.randomUUID(), remindAt: new Date('2030-01-01') });
  while (!releaseSchedule) await new Promise((resolve) => setImmediate(resolve));
  const switched = notifications.selectNotificationAccount('account-b');
  releaseSchedule();
  await switched;
  assert.deepEqual(await old, { id: null, permission: 'denied' });
  assert.deepEqual(cancelled, ['delayed-old-account']);
  assert.equal(cleared, 2);
  assert.equal(scheduledContent?.title, 'Everclose reminder');
  assert.equal(scheduledContent?.body, 'Open Everclose to review your reminder.');
  assert.equal(JSON.stringify(scheduledContent).includes('Private Name'), false);
  assert.equal(JSON.stringify(scheduledContent).includes('Sensitive topic'), false);
});

test('a reminder refresh cancels a late schedule in the same account while preserving delivered notifications', async () => {
  let release: (() => void) | undefined;
  let dismissed = 0;
  const cancelled: string[] = [];
  const notifications = loadTypescript('../apps/mobile/src/native/notifications.ts', {
    'expo-notifications': {
      setNotificationHandler() {}, async cancelAllScheduledNotificationsAsync() {},
      async dismissAllNotificationsAsync() { dismissed++; }, async setBadgeCountAsync() {},
      async getPermissionsAsync() { return { status: 'granted' }; },
      SchedulableTriggerInputTypes: { DATE: 'date' },
      async scheduleNotificationAsync() { await new Promise<void>((resolve) => { release = resolve; }); return 'stale-time'; },
      async cancelScheduledNotificationAsync(id: string) { cancelled.push(id); },
    },
  });
  await notifications.selectNotificationAccount('same-account');
  const pending = notifications.scheduleReminderNotification({ accountScope: 'same-account', contactName: 'Ana',
    reminderTitle: 'Reminder', contactId: crypto.randomUUID(), remindAt: new Date('2030-01-01'), requestPermission: false });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const refreshed = notifications.selectNotificationAccount('same-account', { dismissDelivered: false });
  release();
  await refreshed;
  assert.deepEqual(await pending, { id: null, permission: 'denied' });
  assert.deepEqual(cancelled, ['stale-time']); assert.equal(dismissed, 1);
});

test('stable reminder/date identifiers replace repeats while serialized refresh cannot cancel a newer schedule', async () => {
  const requests = new Map<string, unknown>();
  let release: (() => void) | undefined, calls = 0;
  const notifications = loadTypescript('../apps/mobile/src/native/notifications.ts', {
    'expo-notifications': {
      setNotificationHandler() {}, async cancelAllScheduledNotificationsAsync() { requests.clear(); },
      async dismissAllNotificationsAsync() {}, async setBadgeCountAsync() {},
      async getPermissionsAsync() { return { status: 'granted' }; }, SchedulableTriggerInputTypes: { DATE: 'date' },
      async scheduleNotificationAsync(input: { identifier: string }) {
        if (++calls === 1) await new Promise<void>((resolve) => { release = resolve; });
        requests.set(input.identifier, input); return input.identifier;
      },
      async cancelScheduledNotificationAsync(id: string) { requests.delete(id); },
    },
  });
  await notifications.selectNotificationAccount('same-account');
  const options = { accountScope: 'same-account', reminderId: crypto.randomUUID(), contactId: crypto.randomUUID(),
    contactName: 'Person', reminderTitle: 'Private reminder', remindAt: new Date('2030-01-01'), requestPermission: false };
  const old = notifications.scheduleReminderNotification(options);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const transition = notifications.selectNotificationAccount('same-account', { dismissDelivered: false });
  const fresh = notifications.scheduleReminderNotification(options);
  release(); await transition;
  assert.deepEqual(await old, { id: null, permission: 'denied' });
  const result = await fresh as { id: string; permission: string };
  assert.equal(result.permission, 'granted'); assert.equal(requests.size, 1); assert.ok(requests.has(result.id));
  assert.equal((await notifications.scheduleReminderNotification(options) as { id: string }).id, result.id);
  assert.equal(requests.size, 1);
  const newDate = await notifications.scheduleReminderNotification({ ...options, remindAt: new Date('2030-01-02') }) as { id: string };
  assert.notEqual(newDate.id, result.id);
  await notifications.selectNotificationAccount('another-account');
  const other = await notifications.scheduleReminderNotification({ ...options, accountScope: 'another-account' }) as { id: string };
  assert.notEqual(other.id, result.id); assert.equal(requests.size, 1);
});

test('explicit cancellation waits for an in-flight schedule instead of letting its late reply recreate the alert', async () => {
  const requests = new Set<string>();
  let release: (() => void) | undefined, identifier = '';
  const notifications = loadTypescript('../apps/mobile/src/native/notifications.ts', {
    'expo-notifications': {
      setNotificationHandler() {}, async cancelAllScheduledNotificationsAsync() { requests.clear(); },
      async dismissAllNotificationsAsync() {}, async setBadgeCountAsync() {},
      async getPermissionsAsync() { return { status: 'granted' }; }, SchedulableTriggerInputTypes: { DATE: 'date' },
      async scheduleNotificationAsync(input: { identifier: string }) {
        identifier = input.identifier; await new Promise<void>((resolve) => { release = resolve; });
        requests.add(identifier); return identifier;
      },
      async cancelScheduledNotificationAsync(id: string) { requests.delete(id); },
    },
  });
  await notifications.selectNotificationAccount('account');
  const pending = notifications.scheduleReminderNotification({ accountScope: 'account', reminderId: crypto.randomUUID(),
    contactId: crypto.randomUUID(), contactName: 'Person', reminderTitle: 'Reminder', remindAt: new Date('2030-01-01'), requestPermission: false });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const cancelled = notifications.cancelReminderNotification(identifier);
  release(); await pending; await cancelled;
  assert.equal(requests.size, 0);
});
