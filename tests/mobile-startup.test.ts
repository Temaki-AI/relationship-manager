import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { accountScope, type NativeAccount } from '../packages/domain/src/devices.ts';
import { createMobileHarness } from './helpers/mobile-harness.ts';

type Element = { type: unknown; props: Record<string, unknown>; key?: string };
const jsx = (type: unknown, props: Record<string, unknown>, key?: string): Element => ({ type, props, key });
function load(filename: string, modules: Record<string, unknown>) {
  const result = { exports: {} as Record<string, unknown> };
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  new Function('require', 'module', 'exports', code)((name: string) => {
    assert.ok(name in modules, `Unexpected startup dependency: ${name}`); return modules[name];
  }, result, result.exports);
  return result.exports;
}
const account: NativeAccount = {
  origin: 'https://everclosecrm.com', userId: 'startup-test', workspaceId: 'startup-test',
  deviceId: '00000000-0000-4000-8000-000000000001', email: 'startup@example.test', name: 'Startup test',
  expiresAt: '2027-01-01T00:00:00Z', token: 'everclose_device_' + 'a'.repeat(43),
};

// Run the actual component's effects with controlled async replies. Native
// rendering and real Keychain/SQLite startup are checked separately in iOS CI.
function startupFixture(database: Record<string, unknown> = {}) {
  const states: unknown[] = [], effects = new Map<number, { deps: unknown[]; cleanup?: () => void }>();
  let cursor = 0, currentAccount: NativeAccount | null = account, startupError: string | null = null;
  let resolveName = async (value: NativeAccount | null) => value ? 'account-cache.db' : 'bonds-mobile.db';
  const pending: Array<() => void> = [];
  let identity = async () => '00000000-0000-4000-8000-000000000002', reloads = 0;
  const modules = {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    react: {
      useState(initial: unknown) { const position = cursor++; if (!(position in states)) states[position] = initial;
        return [states[position], (value: unknown) => { states[position] = typeof value === 'function' ? value(states[position]) : value; }]; },
      useEffect(effect: () => (() => void) | undefined, deps: unknown[]) {
        const position = cursor++, previous = effects.get(position);
        if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
          previous?.cleanup?.(); const entry = { deps, cleanup: undefined as (() => void) | undefined };
          effects.set(position, entry); pending.push(() => { entry.cleanup = effect(); });
        }
      },
      useCallback(fn: unknown) { cursor++; return fn; },
    },
    'expo-sqlite': { SQLiteProvider: 'SQLiteProvider' },
    'react-native': { ActivityIndicator: 'ActivityIndicator', Platform: { OS: 'ios' } },
    '@/data/database': database,
    '@/native/account': { accountDatabaseName: (value: NativeAccount | null) => resolveName(value),
      useNativeAccount: () => ({ account: currentAccount, loading: false, startupError, reload: async () => { reloads++; } }) },
    '../../../../packages/domain/src/devices': { accountScope },
    '@/native/device-installation': { deviceContactInstallation: () => identity() },
    '@/data/device-source-sync': { bindDeviceInstallation: async () => {} },
    '@/theme': { palette: { primary: 'primary' } },
    './startup-recovery': { StartupBoundary: 'StartupBoundary', StartupRecovery: 'StartupRecovery' },
  };
  const component = load('apps/mobile/src/components/account-database.tsx', modules).AccountDatabase as (props: { children: unknown }) => Element;
  return {
    render() { cursor = 0; const tree = component({ children: 'private-workspace' }); pending.splice(0).forEach((effect) => effect()); return tree; },
    setAccount(value: NativeAccount | null) { currentAccount = value; },
    setResolver(value: typeof resolveName) { resolveName = value; },
    setIdentity(value: typeof identity) { identity = value; },
    setStartupError(value: string | null) { startupError = value; },
    reloads: () => reloads,
    dispose() { effects.forEach((entry) => entry.cleanup?.()); },
  };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const provider = (tree: Element) => { assert.equal(tree.type, 'StartupBoundary'); return tree.props.children as Element; };

test('a failed account-cache lookup offers retry and never opens a different or local-only database', async () => {
  const f = startupFixture();
  f.setResolver(async () => { throw new Error('Private filename or crypto diagnostics'); });
  assert.equal(f.render().type, 'ActivityIndicator'); await settle();
  const recovery = f.render(); assert.equal(recovery.type, 'StartupRecovery');
  assert.equal(JSON.stringify(recovery).includes('Private filename'), false);
  f.setResolver(async () => 'original-account-cache.db');
  (recovery.props.onRetry as () => void)(); f.render(); await settle();
  assert.equal(provider(f.render()).props.databaseName, 'original-account-cache.db');
  f.dispose();
});

test('late startup success and failure cannot expose or block the next account', async () => {
  for (const failure of [false, true]) {
    const f = startupFixture(); let resolve!: (name: string) => void, reject!: (error: Error) => void;
    f.setResolver(() => new Promise<string>((yes, no) => { resolve = yes; reject = no; }));
    f.render();
    f.setAccount({ ...account, userId: 'second-owner' });
    f.setResolver(async () => 'second-owner-cache.db');
    assert.equal(f.render().type, 'ActivityIndicator'); await settle();
    const current = f.render(); assert.equal(provider(current).props.databaseName, 'second-owner-cache.db');
    assert.equal(current.key, accountScope({ ...account, userId: 'second-owner' }));
    if (failure) reject(new Error('Old account unavailable')); else resolve('old-owner-cache.db');
    await settle(); assert.equal(provider(f.render()).props.databaseName, 'second-owner-cache.db');
    f.dispose();
  }
});

test('startup retry releases a failed SQLite handle and preserves the original people, drafts and outbox', async () => {
  const phone = await createMobileHarness(account);
  try {
    const person = await phone.contacts.createContact(phone.db, { name: 'Saved person', notes: 'Original offline note' });
    const before = JSON.stringify(phone.sqlite.prepare('SELECT * FROM contacts ORDER BY id').all());
    const queue = JSON.stringify(phone.sqlite.prepare('SELECT * FROM sync_queue ORDER BY id').all());
    let closes = 0;
    const f = startupFixture(phone.database);
    f.setIdentity(async () => { throw new Error('The device is locked'); });
    f.render(); await settle();
    const initialize = provider(f.render()).props.onInit as (db: unknown) => Promise<void>;
    const db = { ...phone.db, closeAsync: async () => { closes++; } };
    await assert.rejects(initialize(db), /device is locked/); assert.equal(closes, 1);
    assert.equal(JSON.stringify(phone.sqlite.prepare('SELECT * FROM contacts ORDER BY id').all()), before);
    assert.equal(JSON.stringify(phone.sqlite.prepare('SELECT * FROM sync_queue ORDER BY id').all()), queue);
    f.setIdentity(async () => '00000000-0000-4000-8000-000000000002');
    await (provider(f.render()).props.onInit as (db: unknown) => Promise<void>)(db);
    assert.equal(closes, 1);
    assert.equal((await phone.contacts.getContact(phone.db, person.id))?.notes, 'Original offline note');
    assert.equal(JSON.stringify(phone.sqlite.prepare('SELECT * FROM sync_queue ORDER BY id').all()), queue);
    f.dispose();
  } finally { phone.close(); }
});

test('newer schemas and account ownership failures stop startup without resetting saved data', async () => {
  const phone = await createMobileHarness(account);
  try {
    await phone.contacts.createContact(phone.db, { name: 'Keep this person' });
    const before = JSON.stringify(phone.sqlite.prepare('SELECT * FROM contacts').all());
    const f = startupFixture(phone.database); f.render(); await settle();
    const initialize = provider(f.render()).props.onInit as (db: unknown) => Promise<void>;
    let closes = 0; const db = { ...phone.db, closeAsync: async () => { closes++; } };
    phone.sqlite.pragma('user_version = 15'); await assert.rejects(initialize(db), /supports 14/);
    assert.equal(phone.sqlite.pragma('user_version', { simple: true }), 15);
    phone.sqlite.pragma('user_version = 14');
    phone.sqlite.prepare("UPDATE app_metadata SET value = 'other-account' WHERE key = 'account-scope'").run();
    await assert.rejects(initialize(db), /another account/); assert.equal(closes, 2);
    assert.equal(JSON.stringify(phone.sqlite.prepare('SELECT * FROM contacts').all()), before);
    f.dispose();
  } finally { phone.close(); }
});

test('startup recovery reveals its screen even when hiding the native splash fails, without exposing raw errors', async () => {
  let hideCalls = 0; const effects: Array<() => void> = [];
  class Component {
    props: Record<string, unknown>; state: Record<string, unknown> = {};
    constructor(props: Record<string, unknown>) { this.props = props; }
    setState(value: Record<string, unknown>) { Object.assign(this.state, value); }
  }
  const loaded = load('apps/mobile/src/components/startup-recovery.tsx', {
    'react/jsx-runtime': { jsx, jsxs: jsx }, react: { Component, useEffect: (effect: () => void) => effects.push(effect) },
    'expo-splash-screen': { hideAsync: async () => { hideCalls++; throw new Error('Native splash no longer exists'); } },
    'react-native': { ScrollView: 'ScrollView', Text: 'Text', StyleSheet: { create: (styles: unknown) => styles } },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    './design-system': { ActionButton: 'ActionButton', BrandLockup: 'BrandLockup', Surface: 'Surface' },
    '@/theme': { fonts: {}, palette: {} },
  });
  const Boundary = loaded.StartupBoundary as typeof Component & { getDerivedStateFromError(error: unknown): Record<string, unknown> };
  const boundary = new Boundary({ children: 'workspace' }) as Component & { render(): Element | string };
  assert.equal(boundary.render(), 'workspace');
  boundary.setState(Boundary.getDerivedStateFromError(new Error('Private database path')));
  const recovery = boundary.render() as Element;
  assert.equal(JSON.stringify(recovery).includes('Private database path'), false);
  const screen = (loaded.StartupRecovery as (props: unknown) => Element)(recovery.props);
  assert.ok(JSON.stringify(screen).includes('keep the app installed'));
  effects.forEach((effect) => effect()); await settle(); assert.equal(hideCalls, 1);
  (recovery.props.onRetry as () => void)(); assert.equal(boundary.render(), 'workspace');
});

test('locked account credentials use the same recovery screen and retry the credential read', async () => {
  const f = startupFixture(); f.setStartupError('Unlock your iPhone and try again.');
  const screen = f.render(); assert.equal(screen.type, 'StartupRecovery');
  assert.equal(screen.props.retryLabel, 'Try unlocking again');
  (screen.props.onRetry as () => void)(); await settle(); assert.equal(f.reloads(), 1); f.dispose();
});
