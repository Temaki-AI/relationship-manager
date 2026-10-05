import assert from 'node:assert/strict';
import test from 'node:test';
import { AppLockController, type LockAppState } from '../src/native/app-lock-controller.ts';

function fixture(raw: string | null = null, appState: LockAppState = 'active') {
  let saved = raw, readFailure = false, writeFailure = false;
  let calls = 0, writes = 0, authentication: () => Promise<boolean> = async () => true;
  const controller = new AppLockController({ read: async () => { if (readFailure) throw new Error('Private keychain details'); return saved; },
    write: async (value) => { writes++; saved = value; if (writeFailure) throw new Error('Lost committed reply'); },
    authenticate: () => { calls++; return authentication(); } }, appState);
  const displayed = () => { const s = controller.getSnapshot(); return s.loaded && (!s.enabled || !s.locked) && s.appState === 'active'; };
  return { controller, displayed, value: () => saved, calls: () => calls, writes: () => writes,
    setReadFailure(value: boolean) { readFailure = value; }, setWriteFailure(value: boolean) { writeFailure = value; },
    setAuthentication(value: () => Promise<boolean>) { authentication = value; } };
}
function deferred() { let finish!: (value: boolean) => void; const promise = new Promise<boolean>((resolve) => { finish = resolve; }); return { promise, finish }; }

test('app lock defaults off, does not prompt at startup and trusts only an explicit stored policy', async () => {
  for (const raw of [null, 'disabled-v1']) {
    const f = fixture(raw); assert.equal(f.displayed(), false); await f.controller.load();
    assert.equal(f.displayed(), true); assert.equal(f.calls(), 0); assert.equal(f.writes(), 0);
  }
  const f = fixture('enabled-v1'); await f.controller.load(); assert.equal(f.displayed(), false); assert.equal(f.calls(), 0);
});

test('enabling lock requires fresh device proof, persists independently of accounts and requires unlocking after restart', async () => {
  const f = fixture(); await f.controller.load();
  f.setAuthentication(async () => { assert.equal(f.writes(), 0); return true; });
  assert.equal(await f.controller.changeEnabled(true), true); assert.equal(f.value(), 'enabled-v1'); assert.equal(f.displayed(), true);
  const restarted = fixture(f.value()); await restarted.controller.load(); assert.equal(restarted.displayed(), false);
  assert.equal(await restarted.controller.unlock(), true); assert.equal(restarted.displayed(), true);
  assert.equal(await restarted.controller.unlock(), true); assert.equal(restarted.calls(), 1);
});

test('cancelled and unavailable authentication never enables lock or changes the saved policy', async () => {
  const f = fixture(); await f.controller.load();
  f.setAuthentication(async () => false); assert.equal(await f.controller.changeEnabled(true), false);
  f.setAuthentication(async () => { throw new Error('Sensitive OS details'); }); assert.equal(await f.controller.changeEnabled(true), false);
  assert.equal(f.value(), null); assert.equal(f.writes(), 0); assert.equal(f.displayed(), true);
  assert.doesNotMatch(f.controller.getSnapshot().error!, /Sensitive/);
});

test('the authentication prompt can make iOS inactive without invalidating its own proof or revealing inactive content', async () => {
  const f = fixture('enabled-v1'); await f.controller.load();
  f.setAuthentication(async () => { f.controller.lifecycle('inactive'); assert.equal(f.displayed(), false); return true; });
  assert.equal(await f.controller.unlock(), true); assert.equal(f.displayed(), false);
  assert.equal(f.controller.getSnapshot().coverPresented, true, 'the native lock modal remains under its own OS authentication prompt');
  f.controller.lifecycle('active'); assert.equal(f.displayed(), true); assert.equal(f.controller.getSnapshot().coverPresented, false);
  f.controller.lifecycle('inactive'); f.controller.lifecycle('active'); assert.equal(f.displayed(), false, 'ordinary inactive transitions require another unlock');
});

test('backgrounding during a pending authentication fences a late success even after returning active', async () => {
  for (const action of ['unlock', 'enable'] as const) {
    const f = fixture(action === 'unlock' ? 'enabled-v1' : null); await f.controller.load(); const pending = deferred();
    f.setAuthentication(() => pending.promise);
    const result = action === 'unlock' ? f.controller.unlock() : f.controller.changeEnabled(true);
    f.controller.lifecycle('background'); f.controller.lifecycle('active'); pending.finish(true);
    assert.equal(await result, false); assert.equal(f.writes(), 0);
    assert.equal(f.controller.getSnapshot().enabled, action === 'unlock');
    if (action === 'unlock') assert.equal(f.displayed(), false);
  }
});

test('a background event between OS proof completion and its caller cannot unlock or save protection from an older session', async () => {
  for (const action of ['unlock', 'enable'] as const) {
    const f = fixture(action === 'unlock' ? 'enabled-v1' : null); await f.controller.load(); const pending = deferred();
    f.setAuthentication(() => pending.promise);
    const result = action === 'unlock' ? f.controller.unlock() : f.controller.changeEnabled(true);
    pending.finish(true); queueMicrotask(() => { f.controller.lifecycle('background'); f.controller.lifecycle('active'); });
    assert.equal(await result, false); assert.equal(f.writes(), 0);
    if (action === 'unlock') assert.equal(f.displayed(), false);
  }
});

test('duplicate unlock taps use one native prompt and lock-now invalidates that in-flight proof', async () => {
  const f = fixture('enabled-v1'); await f.controller.load(); const pending = deferred(); f.setAuthentication(() => pending.promise);
  const first = f.controller.unlock(); assert.equal(await f.controller.unlock(), false); assert.equal(f.calls(), 1);
  f.controller.lockNow(); pending.finish(true); assert.equal(await first, false); assert.equal(f.displayed(), false);
});

test('a committed policy write with a lost reply reloads authoritative protection and stays locked', async () => {
  const f = fixture(); await f.controller.load(); f.setWriteFailure(true);
  assert.equal(await f.controller.changeEnabled(true), false); assert.equal(f.value(), 'enabled-v1'); assert.equal(f.displayed(), false);
  assert.equal(f.controller.getSnapshot().enabled, true); assert.equal(f.controller.getSnapshot().saving, false);
  f.setWriteFailure(false); assert.equal(await f.controller.unlock(), true); assert.equal(f.displayed(), true);
});

test('malformed or inaccessible lock storage fails closed and can retry without clearing any stored value', async () => {
  const invalid = fixture('malformed'); await invalid.controller.load(); assert.equal(invalid.displayed(), false); assert.equal(invalid.value(), 'malformed'); assert.equal(invalid.writes(), 0);
  const f = fixture('enabled-v1'); f.setReadFailure(true); await f.controller.load(); assert.equal(f.displayed(), false); assert.equal(await f.controller.unlock(), false);
  assert.doesNotMatch(f.controller.getSnapshot().error!, /Private/); f.setReadFailure(false); await f.controller.load();
  assert.equal(f.controller.getSnapshot().enabled, true); assert.equal(f.displayed(), false); assert.equal(f.value(), 'enabled-v1');
});

test('disabling lock needs a new authenticated action and an unknown initial lifecycle never exposes private content', async () => {
  const f = fixture('enabled-v1'); await f.controller.load(); assert.equal(await f.controller.changeEnabled(false), false);
  await f.controller.unlock(); f.setAuthentication(async () => false); assert.equal(await f.controller.changeEnabled(false), false); assert.equal(f.value(), 'enabled-v1');
  f.setAuthentication(async () => true); assert.equal(await f.controller.changeEnabled(false), true); assert.equal(f.value(), 'disabled-v1'); assert.equal(f.displayed(), true);
  const unknown = fixture(null, 'unknown'); await unknown.controller.load(); assert.equal(unknown.displayed(), false);
  unknown.controller.lifecycle('active'); assert.equal(unknown.displayed(), true);
});

test('an unreadable policy can be repaired only after device verification, keeping protection enabled and preserving restart safety', async () => {
  const f = fixture('malformed'); await f.controller.load(); f.setAuthentication(async () => false);
  assert.equal(await f.controller.repair(), false); assert.equal(f.value(), 'malformed'); assert.equal(f.writes(), 0); assert.equal(f.displayed(), false);
  f.setAuthentication(async () => true); assert.equal(await f.controller.repair(), true); assert.equal(f.value(), 'enabled-v1'); assert.equal(f.displayed(), true);
  const restarted = fixture(f.value()); await restarted.controller.load(); assert.equal(restarted.displayed(), false);
});

test('repair cannot use an old foreground proof or report an unavailable write as a disabled lock', async () => {
  const f = fixture('malformed'); await f.controller.load(); const pending = deferred(); f.setAuthentication(() => pending.promise);
  const result = f.controller.repair(); f.controller.lifecycle('background'); f.controller.lifecycle('active'); pending.finish(true);
  assert.equal(await result, false); assert.equal(f.value(), 'malformed'); assert.equal(f.writes(), 0);
  f.setAuthentication(async () => true); f.setWriteFailure(true); assert.equal(await f.controller.repair(), false);
  assert.equal(f.controller.getSnapshot().enabled, true); assert.equal(f.displayed(), false);
});
