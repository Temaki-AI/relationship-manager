import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const { NextRequest } = require('next/server');
const cache = new Map<string, { exports: Record<string, unknown> }>();
function load(filename: string): Record<string, unknown> {
  const existing = cache.get(filename); if (existing) return existing.exports;
  const loadedModule = { exports: {} }; cache.set(filename, loadedModule);
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)((name: string) => {
    if (name.startsWith('@/') || name.startsWith('.')) {
      let resolved = name.startsWith('@/') ? path.resolve(name.slice(2)) : path.resolve(path.dirname(filename), name);
      if (!path.extname(resolved)) resolved += '.ts';
      return load(resolved);
    }
    return require(name);
  }, loadedModule, loadedModule.exports);
  return loadedModule.exports;
}
const middleware = load(path.resolve('middleware.ts')).middleware as (request: InstanceType<typeof NextRequest>) => Promise<Response>;

test('Google-mode middleware permits only the native sync/session candidates and keeps security controls', async () => {
  const previous = process.env.AUTH_MODE; process.env.AUTH_MODE = 'google';
  const credential = `Bearer everclose_device_${randomBytes(32).toString('base64url')}`;
  try {
    for (const suffix of ['sync/bootstrap', 'sync/pull', 'sync/push', 'devices/session', 'calendar-event-links/push']) {
      const response = await middleware(new NextRequest(`https://everclosecrm.com/api/v1/${suffix}`, { headers: { Authorization: credential } }));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-middleware-rewrite'), `https://everclosecrm.com/api/cloud/v1/${suffix}`);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
    for (const version of [2, 3, 4]) for (const action of ['bootstrap', 'pull', 'push']) {
      const response = await middleware(new NextRequest(`https://everclosecrm.com/api/v${version}/sync/${action}`, { headers: { Authorization: credential } }));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-middleware-rewrite'), `https://everclosecrm.com/api/cloud/v${version}/sync/${action}`);
    }
    for (const pathname of ['/api/settings/erase', '/api/settings/backups', '/api/v1/devices',
      '/api/v1/devices/authorize', '/api/contacts', '/api/cloud/v1/sync/push', '/api/v1/sync/unknown', '/api/v1/calendar-event-links/pull', '/api/v1/calendar-event-links/push/extra', '/api/v3/sync/unknown', '/api/v4/sync/unknown', '/api/v5/sync/push']) {
      assert.equal((await middleware(new NextRequest(`https://everclosecrm.com${pathname}`, { headers: { Authorization: credential } }))).status, 401, pathname);
    }
    assert.equal((await middleware(new NextRequest('https://everclosecrm.com/api/v1/sync/pull', { headers: { Authorization: 'Bearer invalid' } }))).status, 401);
    assert.equal((await middleware(new NextRequest('https://everclosecrm.com/api/v1/sync/push', { method: 'POST', headers: { Authorization: credential, Origin: 'https://attacker.invalid' } }))).status, 403);
    assert.equal((await middleware(new NextRequest('https://everclosecrm.com/api/v4/sync/push', { method: 'POST', headers: { Authorization: credential, Origin: 'https://attacker.invalid' } }))).status, 403);
    assert.equal((await middleware(new NextRequest('https://everclosecrm.com/api/v1/calendar-event-links/push', { method: 'POST', headers: { Authorization: credential, Origin: 'https://attacker.invalid' } }))).status, 403);
    // Session hashes are validated in the dispatcher, not accepted solely on this syntactic middleware gate.
  } finally { if (previous === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = previous; }
});

test('phone approval navigation retains PKCE and state through the web login redirect while code exchange stays public', async () => {
  const previous = process.env.AUTH_MODE; process.env.AUTH_MODE = 'google';
  try {
    const target = `/connect-device?challenge=${randomBytes(32).toString('base64url')}&state=${randomBytes(32).toString('hex')}&deviceName=iPhone`;
    const response = await middleware(new NextRequest(`https://everclosecrm.com${target}`, { headers: { Accept: 'text/html' } }));
    assert.equal(response.status, 307);
    const location = new URL(response.headers.get('Location')!);
    assert.equal(location.origin, 'https://everclosecrm.com'); assert.equal(location.pathname, '/login');
    assert.equal(location.searchParams.get('next'), target);
    assert.equal((await middleware(new NextRequest('https://everclosecrm.com/api/auth/device/exchange', { method: 'POST' }))).headers.get('x-middleware-next'), '1');
  } finally { if (previous === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = previous; }
});
