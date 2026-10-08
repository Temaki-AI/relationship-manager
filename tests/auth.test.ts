import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createSessionToken,
  getAuthConfiguration,
  getBearerToken,
  getCookieValue,
  isApiTokenPath,
  getSafeReturnPath,
  MAXIMUM_SESSION_TTL_HOURS,
  SESSION_TTL_SECONDS,
  verifyCredential,
  verifySessionToken,
} from '../lib/auth.ts';

const validEnvironment = {
  NODE_ENV: 'production',
  CRM_PASSWORD: 'a-strong-password',
  CRM_SESSION_SECRET: 'a-session-secret-that-is-longer-than-32-characters',
  CRM_API_TOKEN: 'an-api-token-that-is-longer-than-32-characters',
};

test('authentication is open only for unconfigured non-production development', () => {
  assert.deepEqual(getAuthConfiguration({ NODE_ENV: 'development' }), { mode: 'disabled' });
  assert.equal(getAuthConfiguration({ NODE_ENV: 'production' }).mode, 'misconfigured');
  assert.equal(getAuthConfiguration({ ...validEnvironment, CRM_SESSION_SECRET: 'short' }).mode, 'misconfigured');
  const enabled = getAuthConfiguration(validEnvironment);
  assert.equal(enabled.mode, 'enabled');
  if (enabled.mode === 'enabled') assert.equal(enabled.sessionTtlSeconds, SESSION_TTL_SECONDS);
  const oneDay = getAuthConfiguration({ ...validEnvironment, CRM_SESSION_TTL_HOURS: '24' });
  assert.equal(oneDay.mode, 'enabled');
  if (oneDay.mode === 'enabled') assert.equal(oneDay.sessionTtlSeconds, 24 * 60 * 60);
  for (const invalid of ['0', '1.5', String(MAXIMUM_SESSION_TTL_HOURS + 1), 'forever']) {
    assert.equal(
      getAuthConfiguration({ ...validEnvironment, CRM_SESSION_TTL_HOURS: invalid }).mode,
      'misconfigured',
      invalid
    );
  }
});

test('signed sessions are unique, password-bound, and reject tampering and expiration', async () => {
  const now = Date.UTC(2026, 6, 10, 12, 0, 0);
  const secret = validEnvironment.CRM_SESSION_SECRET;
  const password = validEnvironment.CRM_PASSWORD;
  const [token, secondToken] = await Promise.all([
    createSessionToken(secret, password, now),
    createSessionToken(secret, password, now),
  ]);

  assert.match(token, /^v2\./);
  assert.notEqual(token, secondToken);
  assert.equal(await verifySessionToken(token, secret, password, now), true);
  assert.equal(await verifySessionToken(`${token}x`, secret, password, now), false);
  assert.equal(await verifySessionToken(token, secret, 'rotated-password', now), false);
  assert.equal(await verifySessionToken(token, `${secret}-rotated`, password, now), false);
  assert.equal(await verifySessionToken('v1.1.2.invalid', secret, password, now), false);
  assert.equal(
    await verifySessionToken(
      token,
      secret,
      password,
      now + (SESSION_TTL_SECONDS + 1) * 1000
    ),
    false
  );
  assert.equal(
    await verifySessionToken(token, secret, password, now, 60 * 60),
    false
  );

  const shortToken = await createSessionToken(secret, password, now, 60 * 60);
  assert.equal(await verifySessionToken(shortToken, secret, password, now, 60 * 60), true);
  assert.equal(
    await verifySessionToken(shortToken, secret, password, now + 60 * 60 * 1000, 60 * 60),
    false
  );
  await assert.rejects(
    createSessionToken(secret, password, now, SESSION_TTL_SECONDS + 1),
    /Session lifetime is invalid/
  );
});

test('credentials are compared without exposing the expected value', async () => {
  assert.equal(await verifyCredential('correct horse', 'correct horse'), true);
  assert.equal(await verifyCredential('correct horse', 'wrong horse'), false);
});

test('cookie, bearer, and return-path parsing reject unsafe input', () => {
  assert.equal(getCookieValue('theme=light; bonds_session=abc.def; other=1', 'bonds_session'), 'abc.def');
  assert.equal(getBearerToken('Bearer integration-token'), 'integration-token');
  assert.equal(getBearerToken('Basic credentials'), null);
  assert.equal(isApiTokenPath('/api/import/linkedin'), true);
  assert.equal(isApiTokenPath('/api/contacts'), false);
  assert.equal(isApiTokenPath('/api/settings/backups'), false);
  assert.equal(getSafeReturnPath('/contacts/12?tab=notes'), '/contacts/12?tab=notes');
  assert.equal(getSafeReturnPath('https://attacker.example'), '/');
  assert.equal(getSafeReturnPath('//attacker.example'), '/');
});

test('the consumer logout UI redirects only after the session cookie is cleared', () => {
  const navigation = readFileSync('components/nav-header.tsx', 'utf8');
  const handler = navigation.slice(
    navigation.indexOf('async function handleLogout()'),
    navigation.indexOf('const navItems')
  );

  assert(handler.indexOf('if (!response.ok)') < handler.indexOf("router.replace('/login')"));
  assert.match(handler, /Your session is still active; try again/);
  assert.match(navigation, /disabled=\{signingOut\}/);
  assert.match(navigation, /aria-label=\{signingOut \? 'Signing out' : 'Sign out'\}/);
});
