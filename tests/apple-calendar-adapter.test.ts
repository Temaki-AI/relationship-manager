import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { readAppleCalendarFacts } from '../packages/domain/src/apple-calendar.ts';

function fixture(os = 'ios', version: string | number = '17.0') {
  const calls: string[] = [], platform = { OS: os, Version: version };
  let status = 'denied', ask = true;
  const facts = { id: 'event', calendar_id: 'calendar', title: 'Selected meeting', start: '2026-10-05T00:00:00Z', end: '2026-10-06T00:00:00Z', all_day: true, time_zone: 'Europe/Lisbon', url: 'bonds://calendar/apple/marker', recurring: false, cancelled: false };
  const modules: Record<string, unknown> = {
    'react-native': { Platform: platform },
    'expo-calendar/legacy': {
      async getCalendarPermissionsAsync() { calls.push('getPermission'); return { status, canAskAgain: ask }; },
      async requestCalendarPermissionsAsync() { calls.push('requestPermission'); status = 'granted'; return { status, canAskAgain: true }; },
      async createEventInCalendarAsync() { calls.push('create'); return { action: 'saved', id: 'event' }; },
      async editEventInCalendarAsync(input: unknown) { assert.deepEqual(input, { id: 'event' }); calls.push('edit'); return { action: 'canceled', id: null }; },
    },
    'expo': { requireNativeModule(name: string) {
      assert.equal(name, 'EvercloseCalendarFacts'); calls.push('nativeFacts');
      return { async get(id: string) { assert.equal(id, 'event'); return { ...facts, notes: 'NOT FOR CRM', attendees: ['private'] }; },
        async calendars() { return [{ id: 'calendar', title: 'Personal' }]; },
        async find(calendarId: string, start: string, end: string, url: string) { assert.equal(calendarId, 'calendar'); assert.equal(start, '2026-10-01T00:00:00.000Z'); assert.equal(end, '2026-11-01T00:00:00.000Z'); assert.equal(url, facts.url); return [facts]; } };
    } },
    '../../../../packages/domain/src/apple-calendar': { readAppleCalendarFacts },
  };
  const loadedModule = { exports: {} as typeof import('../apps/mobile/src/native/apple-calendar.ts') };
  const code = ts.transpileModule(readFileSync('apps/mobile/src/native/apple-calendar.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)((name: string) => { assert.ok(Object.hasOwn(modules, name), name); return modules[name]; }, loadedModule, loadedModule.exports);
  return { adapter: loadedModule.exports.appleCalendarAdapter, calls, platform, facts, grant: (value: string, canAskAgain = true) => { status = value; ask = canAskAgain; } };
}

test('The iOS 17+ Calendar editor does not request Calendar read access; SDK 57 uses its supported legacy editor', async () => {
  const f = fixture(); await f.adapter.prepareEditor(); assert.deepEqual(f.calls, []);
  assert.equal((await f.adapter.create({ title: 'Meeting', location: '', startDate: '2026-10-05T00:00:00Z', endDate: '2026-10-06T00:00:00Z', timeZone: 'UTC', allDay: true, url: f.facts.url })).action, 'saved');
  assert.deepEqual(f.calls, ['create']);
});
test('On iOS 16 the editor permission check is explicit, and denied permanent access never opens the editor', async () => {
  const f = fixture('ios', '16.4'); f.grant('denied', false);
  await assert.rejects(f.adapter.prepareEditor(), /needs Calendar permission/); assert.deepEqual(f.calls, ['getPermission']);
  f.grant('undetermined'); await f.adapter.prepareEditor(); assert.deepEqual(f.calls, ['getPermission', 'getPermission', 'requestPermission']);
});
test('Passive permission checks never prompt and native event reads project only the required event facts', async () => {
  const f = fixture(); assert.equal(await f.adapter.permission(false), false); assert.deepEqual(f.calls, ['getPermission']);
  assert.equal(await f.adapter.permission(true), true); assert.ok(f.calls.includes('requestPermission'));
  const facts = await f.adapter.get('event'); assert.equal(facts!.time_zone, 'Europe/Lisbon'); assert.ok(!('notes' in facts!)); assert.ok(!('attendees' in facts!));
  assert.equal((await f.adapter.find('calendar', '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z', f.facts.url)).length, 1);
  assert.equal((await f.adapter.edit('event')).action, 'canceled');
});
test('The Apple bridge cannot invoke native Calendar APIs on Android/web or silently assume an unknown OS version', async () => {
  for (const os of ['android', 'web']) {
    const f = fixture(os, 35); await assert.rejects(f.adapter.prepareEditor(), /iPhone/); await assert.rejects(f.adapter.permission(true), /iPhone/); await assert.rejects(f.adapter.get('event'), /iPhone/); assert.deepEqual(f.calls, []);
  }
  const f = fixture('ios', 'unknown'); await assert.rejects(f.adapter.prepareEditor(), /version/); assert.deepEqual(f.calls, []);
});
