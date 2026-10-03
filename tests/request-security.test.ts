import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildContentSecurityPolicy,
  isPublicAppPath,
  isRequestOriginAllowed,
  isRequestSecure,
  trustsProxyHeaders,
} from '../lib/request-security.ts';

const baseInput = {
  requestUrl: 'https://bonds.example/api/contacts',
  host: 'bonds.example',
  allowedOrigins: ['https://companion.example'],
  allowedExtensionIds: ['abcdefghijklmnopabcdefghijklmnop'],
};

test('proxy headers require an explicit trust setting', () => {
  assert.equal(trustsProxyHeaders({}), false);
  assert.equal(trustsProxyHeaders({ CRM_TRUST_PROXY_HEADERS: 'false' }), false);
  assert.equal(trustsProxyHeaders({ CRM_TRUST_PROXY_HEADERS: 'true' }), true);
  assert.equal(trustsProxyHeaders({ CRM_TRUST_PROXY_HEADERS: '1' }), true);
});

test('secure transport detection trusts forwarded protocol only when configured', () => {
  assert.equal(isRequestSecure({ requestUrl: 'https://bonds.example/login' }), true);
  assert.equal(isRequestSecure({ requestUrl: 'http://localhost:3100/login' }), false);
  assert.equal(isRequestSecure({
    requestUrl: 'http://127.0.0.1:3100/login',
    forwardedProto: 'https',
    trustProxy: true,
  }), true);
  assert.equal(isRequestSecure({
    requestUrl: 'http://127.0.0.1:3100/login',
    forwardedProto: 'https',
    trustProxy: false,
  }), false);
  assert.equal(isRequestSecure({
    requestUrl: 'https://bonds.internal/login',
    forwardedProto: 'http, https',
    trustProxy: true,
  }), false);
});

test('production CSP trusts only nonced scripts and required app resources', () => {
  const nonce = 'cHJvZHVjdGlvbi1ub25jZS0yMDI2';
  const policy = buildContentSecurityPolicy({
    nonce,
    upgradeInsecureRequests: true,
  });

  assert.match(policy, new RegExp(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`));
  assert.match(policy, /script-src-attr 'none'/);
  assert.match(policy, /style-src 'self' 'nonce-/);
  assert.match(policy, /style-src-attr 'unsafe-inline'/);
  assert.match(policy, /img-src 'self' data: blob:/);
  assert.doesNotMatch(policy, /img-src[^;]*https:/);
  assert.match(policy, /connect-src 'self'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /upgrade-insecure-requests$/);
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/);
  assert.doesNotMatch(policy, /'unsafe-eval'/);
  assert.doesNotMatch(policy, /connect-src[^;]*wss?:/);
});

test('development CSP permits debugger evaluation and local hot reload only', () => {
  const policy = buildContentSecurityPolicy({
    nonce: 'ZGV2ZWxvcG1lbnQtbm9uY2UtMjAyNg==',
    development: true,
  });

  assert.match(policy, /script-src[^;]*'unsafe-eval'/);
  assert.match(policy, /style-src 'self' 'unsafe-inline'/);
  assert.match(policy, /connect-src 'self' ws: wss:/);
  assert.doesNotMatch(policy, /upgrade-insecure-requests/);
  assert.throws(
    () => buildContentSecurityPolicy({ nonce: "short'; script-src *" }),
    /nonce is invalid/
  );
});

test('origin policy accepts the current production origin and configured clients', () => {
  assert.equal(isRequestOriginAllowed({ ...baseInput, origin: 'https://bonds.example' }), true);
  assert.equal(isRequestOriginAllowed({ ...baseInput, origin: 'https://companion.example' }), true);
  assert.equal(
    isRequestOriginAllowed({
      ...baseInput,
      origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    }),
    true
  );
});

test('origin policy recognizes a public origin forwarded by a reverse proxy', () => {
  assert.equal(
    isRequestOriginAllowed({
      ...baseInput,
      requestUrl: 'http://127.0.0.1:3100/api/contacts',
      host: '127.0.0.1:3100',
      forwardedHost: 'crm.example',
      forwardedProto: 'https',
      origin: 'https://crm.example',
    }),
    true
  );
});

test('origin policy rejects lookalike hosts, paths, and unregistered extensions', () => {
  assert.equal(isRequestOriginAllowed({ ...baseInput, origin: 'https://bonds.example.attacker.test' }), false);
  assert.equal(isRequestOriginAllowed({ ...baseInput, origin: 'https://bonds.example/path' }), false);
  assert.equal(
    isRequestOriginAllowed({
      ...baseInput,
      origin: 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba',
    }),
    false
  );
  assert.equal(isRequestOriginAllowed({ ...baseInput, origin: null }), true);
});

test('public path policy exposes only authentication and install assets', () => {
  for (const pathname of [
    '/login',
    '/api/health',
    '/api/health/live',
    '/api/health/ready',
    '/api/auth/session',
    '/manifest.webmanifest',
    '/icon.svg',
    '/icons/bonds-192.png',
    '/icons/bonds-512.png',
    '/sw.js',
    '/offline.html',
    '/offline.css',
    '/robots.txt',
  ]) {
    assert.equal(isPublicAppPath(pathname), true, pathname);
  }

  for (const pathname of [
    '/',
    '/contacts',
    '/api/contacts',
    '/api/settings/backups',
    '/api/health/private',
    '/icons/private-contact.png',
    '/manifest.webmanifest/anything',
  ]) {
    assert.equal(isPublicAppPath(pathname), false, pathname);
  }
});
