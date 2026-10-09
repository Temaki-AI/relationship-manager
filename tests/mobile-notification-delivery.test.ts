import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

function fixture() {
  let status = 'undetermined', grant: (() => void) | undefined;
  const scheduled = new Set<string>(), cancelled: string[] = [];
  let scheduleHook: (() => Promise<void>) | undefined;
  const loadedModule = { exports: {} as Record<string, (...args: unknown[]) => Promise<unknown>> };
  const code = ts.transpileModule(readFileSync(new URL('../apps/mobile/src/native/notifications.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const api = {
    setNotificationHandler() {}, async dismissAllNotificationsAsync() {}, async setBadgeCountAsync() {},
    async cancelAllScheduledNotificationsAsync() { scheduled.clear(); },
    async getPermissionsAsync() { return { status }; },
    async requestPermissionsAsync() {
      await new Promise<void>((resolve) => { grant = resolve; });
      status = 'granted'; return { status };
    },
    SchedulableTriggerInputTypes: { DATE: 'date' },
    async scheduleNotificationAsync(input: { identifier: string }) {
      await scheduleHook?.(); scheduled.add(input.identifier); return input.identifier;
    },
    async cancelScheduledNotificationAsync(id: string) { scheduled.delete(id); cancelled.push(id); },
  };
  new Function('require', 'module', 'exports', code)((name: string) => {
    assert.equal(name, 'expo-notifications'); return api;
  }, loadedModule, loadedModule.exports);
  return { native: loadedModule.exports, scheduled, cancelled,
    async waitForPermission() { while (!grant) await new Promise((resolve) => setImmediate(resolve)); },
    async allow() { while (!grant) await new Promise((resolve) => setImmediate(resolve)); grant(); },
    granted() { status = 'granted'; }, onSchedule(hook: () => Promise<void>) { scheduleHook = hook; } };
}

const options = () => ({ accountScope: 'personal', contactId: crypto.randomUUID(), reminderId: crypto.randomUUID(),
  remindAt: new Date('2030-01-01'), reminderTitle: 'Private title', contactName: 'Private name' });

test('allowing the first reminder during an automatic refresh schedules it immediately without restarting', async () => {
  const f = fixture(); await f.native.selectNotificationAccount('personal');
  const pending = f.native.scheduleReminderNotification({ ...options(), isCurrent: async () => true });
  await f.waitForPermission();
  await f.native.selectNotificationAccount('personal', { dismissDelivered: false });
  await f.allow();
  const result = await pending as { id: string | null; permission: string };
  assert.equal(result.permission, 'granted'); assert.ok(result.id); assert.equal(f.scheduled.size, 1);
});

test('a changed time or completed reminder while permission is open never receives the stale alert', async () => {
  const f = fixture(); await f.native.selectNotificationAccount('personal');
  let current = true;
  const pending = f.native.scheduleReminderNotification({ ...options(), isCurrent: async () => current });
  // Wait for the actual permission request before changing the saved reminder.
  await f.waitForPermission(); current = false; await f.allow();
  assert.deepEqual(await pending, { id: null, permission: 'denied' }); assert.equal(f.scheduled.size, 0);
});

test('switching away and back while permission is open cannot revive the original account request', async () => {
  const f = fixture(); await f.native.selectNotificationAccount('personal');
  const pending = f.native.scheduleReminderNotification({ ...options(), isCurrent: async () => true });
  await f.waitForPermission();
  await f.native.selectNotificationAccount('other'); await f.native.selectNotificationAccount('personal');
  await f.allow();
  assert.deepEqual(await pending, { id: null, permission: 'denied' }); assert.equal(f.scheduled.size, 0);
});

test('a same-account refresh during native scheduling retries only a still-current saved reminder', async () => {
  const f = fixture(); f.granted(); await f.native.selectNotificationAccount('personal');
  let release: (() => void) | undefined, calls = 0;
  f.onSchedule(async () => { if (++calls === 1) await new Promise<void>((resolve) => { release = resolve; }); });
  const pending = f.native.scheduleReminderNotification({ ...options(), isCurrent: async () => true });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const refreshed = f.native.selectNotificationAccount('personal', { dismissDelivered: false });
  release(); await refreshed;
  const result = await pending as { id: string | null; permission: string };
  assert.equal(result.permission, 'granted'); assert.ok(result.id); assert.equal(f.scheduled.size, 1);
  assert.equal(calls, 2); assert.equal(f.cancelled.length, 1);
});

test('completion during a native scheduling call cancels its receipt without retrying', async () => {
  const f = fixture(); f.granted(); await f.native.selectNotificationAccount('personal');
  let release: (() => void) | undefined, current = true, calls = 0;
  f.onSchedule(async () => { calls++; await new Promise<void>((resolve) => { release = resolve; }); });
  const pending = f.native.scheduleReminderNotification({ ...options(), isCurrent: async () => current });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  current = false; release();
  assert.deepEqual(await pending, { id: null, permission: 'denied' });
  assert.equal(f.scheduled.size, 0); assert.equal(f.cancelled.length, 1); assert.equal(calls, 1);
});

test('a database failure validating a native receipt cancels it before reporting the failure', async () => {
  const f = fixture(); f.granted(); await f.native.selectNotificationAccount('personal');
  let failRead = false;
  f.onSchedule(async () => { failRead = true; });
  await assert.rejects(f.native.scheduleReminderNotification({ ...options(), isCurrent: async () => {
    if (failRead) throw new Error('Database unavailable'); return true;
  } }), /Database unavailable/);
  assert.equal(f.scheduled.size, 0); assert.equal(f.cancelled.length, 1);
});
