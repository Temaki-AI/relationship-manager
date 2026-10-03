import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

type WorkerEvent = { waitUntil?: (promise: Promise<unknown>) => void; respondWith?: (promise: Promise<unknown>) => void };
type WorkerHandler = (event: WorkerEvent & Record<string, unknown>) => void;

test('service worker caches only public install assets and never intercepts APIs', async () => {
  const source = readFileSync(join(projectRoot, 'public', 'sw.js'), 'utf8');
  const handlers: Record<string, WorkerHandler> = {};
  let addedAssets: string[] = [];
  const deletedCaches: string[] = [];
  let claimed = false;
  let skippedWaiting = false;
  let fetchImplementation = async () => ({ source: 'network' });
  let cachedResponse: unknown = { source: 'offline-shell' };

  const cache = {
    addAll: async (assets: string[]) => { addedAssets = Array.from(assets); },
  };
  const caches = {
    open: async () => cache,
    keys: async () => ['bonds-public-shell-old', 'bonds-public-shell-v1', 'unrelated-cache'],
    delete: async (name: string) => { deletedCaches.push(name); return true; },
    match: async () => cachedResponse,
  };
  const workerSelf = {
    location: { origin: 'https://bonds.example' },
    addEventListener: (name: string, handler: WorkerHandler) => { handlers[name] = handler; },
    skipWaiting: async () => { skippedWaiting = true; },
    clients: { claim: async () => { claimed = true; } },
  };

  vm.runInNewContext(source, {
    self: workerSelf,
    caches,
    fetch: (...args: unknown[]) => fetchImplementation(...args),
    URL,
    Promise,
  });

  let installPromise: Promise<unknown> | undefined;
  handlers.install({ waitUntil: (promise) => { installPromise = promise; } });
  await installPromise;
  assert.deepEqual(addedAssets, [
    '/offline.html',
    '/offline.css',
    '/manifest.webmanifest',
    '/icon.svg',
    '/icons/bonds-192.png',
    '/icons/bonds-512.png',
  ]);
  assert.equal(skippedWaiting, true);

  let activatePromise: Promise<unknown> | undefined;
  handlers.activate({ waitUntil: (promise) => { activatePromise = promise; } });
  await activatePromise;
  assert.deepEqual(deletedCaches, ['bonds-public-shell-old']);
  assert.equal(claimed, true);

  let apiIntercepted = false;
  handlers.fetch({
    request: { method: 'GET', mode: 'cors', url: 'https://bonds.example/api/contacts' },
    respondWith: () => { apiIntercepted = true; },
  });
  assert.equal(apiIntercepted, false);
  handlers.fetch({
    request: { method: 'GET', mode: 'navigate', url: 'https://bonds.example/api/export/jobs/123/download' },
    respondWith: () => { apiIntercepted = true; },
  });
  assert.equal(apiIntercepted, false);

  fetchImplementation = async () => { throw new Error('offline'); };
  cachedResponse = { source: 'offline-shell' };
  let navigationResponse: Promise<unknown> | undefined;
  handlers.fetch({
    request: { method: 'GET', mode: 'navigate', url: 'https://bonds.example/contacts/42' },
    respondWith: (promise) => { navigationResponse = promise; },
  });
  assert.deepEqual(await navigationResponse, { source: 'offline-shell' });
  assert.doesNotMatch(source, /cache\.put|response\.clone/i);
});

test('offline shell is static, accessible, and explicitly privacy-safe', () => {
  const html = readFileSync(join(projectRoot, 'public', 'offline.html'), 'utf8');
  const css = readFileSync(join(projectRoot, 'public', 'offline.css'), 'utf8');
  const provider = readFileSync(join(projectRoot, 'components', 'pwa-provider.tsx'), 'utf8');
  const layout = readFileSync(join(projectRoot, 'app', 'layout.tsx'), 'utf8');
  const manifest = readFileSync(join(projectRoot, 'app', 'manifest.ts'), 'utf8');

  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /never copied into the offline cache/i);
  assert.match(html, /href="\/offline\.css"/);
  assert.doesNotMatch(html, /<script|<form/i);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(provider, /process\.env\.NODE_ENV !== 'production'/);
  assert.match(provider, /updateViaCache: 'none'/);
  for (const source of [html, css, layout, manifest]) {
    assert.match(source, /#cb1a41/i);
    assert.doesNotMatch(source, /#f43f5e/i);
  }
});
