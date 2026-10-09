import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, copyFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertIsolatedConfiguration,
  cloudDevelopmentEnvironment,
  developmentConfigurationProblems,
  ensureDevelopmentEnvironment,
} from '../scripts/development.mjs';

test('setup generates a private independent secret and preserves existing OAuth configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'everclose-development-'));
  try {
    await copyFile(new URL('../.env.development.example', import.meta.url), join(root, '.env.development.example'));
    const first = await ensureDevelopmentEnvironment(root);
    assert.match(first.BETTER_AUTH_SECRET, /^[a-f0-9]{64}$/);
    const keyring = JSON.parse(first.CONNECTOR_TOKEN_KEYRING);
    assert.equal(keyring.active, 'local-v1'); assert.equal(Buffer.from(keyring.keys['local-v1'], 'base64url').length, 32);
    const filename = join(root, '.env.development.local');
    const saved = (await readFile(filename, 'utf8')).replace('GOOGLE_CLIENT_ID=', 'GOOGLE_CLIENT_ID=test-client');
    await writeFile(filename, saved);
    const second = await ensureDevelopmentEnvironment(root);
    assert.equal(second.GOOGLE_CLIENT_ID, 'test-client');
    assert.equal(second.BETTER_AUTH_SECRET, first.BETTER_AUTH_SECRET);
    assert.equal(second.CONNECTOR_TOKEN_KEYRING, first.CONNECTOR_TOKEN_KEYRING);
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cloud development cannot silently inherit production URL, open auth, or active email delivery', () => {
  const environment = cloudDevelopmentEnvironment({
    GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', BETTER_AUTH_SECRET: 'a'.repeat(64),
    AUTH_MODE: '', NEXT_PUBLIC_AUTH_MODE: '', BETTER_AUTH_URL: 'https://everclosecrm.com',
    EMAIL_DELIVERY_ENABLED: 'true', SEED_DEMO_DATA: 'true',
  }, {});
  assert.equal(environment.AUTH_MODE, 'google');
  assert.equal(environment.NEXT_PUBLIC_AUTH_MODE, 'google');
  assert.equal(environment.BETTER_AUTH_URL, 'http://localhost:3100');
  assert.equal(environment.EMAIL_DELIVERY_ENABLED, 'false');
  assert.equal(environment.SEED_DEMO_DATA, 'false');
  assert.deepEqual(developmentConfigurationProblems(environment), []);
  assert.equal(developmentConfigurationProblems({ GOOGLE_CLIENT_ID: ' ', GOOGLE_CLIENT_SECRET: '', BETTER_AUTH_SECRET: '' }).length, 3);
});

test('development rejects a remote binding or a production database ID before starting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'everclose-bindings-'));
  try {
    const production = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
    const local = JSON.parse(await readFile(new URL('../wrangler.local.jsonc', import.meta.url), 'utf8'));
    await writeFile(join(root, 'wrangler.jsonc'), JSON.stringify(production));
    const filename = join(root, 'wrangler.local.jsonc');
    await writeFile(filename, JSON.stringify(local));
    await assertIsolatedConfiguration(root);
    local.d1_databases[0].remote = true;
    await writeFile(filename, JSON.stringify(local));
    await assert.rejects(assertIsolatedConfiguration(root), /isolated simulated storage/);
    local.d1_databases[0].remote = false;
    local.d1_databases[0].database_id = production.d1_databases[0].database_id;
    await writeFile(filename, JSON.stringify(local));
    await assert.rejects(assertIsolatedConfiguration(root), /isolated simulated storage/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cloud development never inherits login, connector or vault credentials from the shell', () => {
  const inherited = {
    GOOGLE_CLIENT_ID: 'production-login', GOOGLE_CLIENT_SECRET: 'production-secret',
    GOOGLE_GMAIL_CLIENT_ID: 'production-gmail', GOOGLE_GMAIL_CLIENT_SECRET: 'production-gmail-secret',
    GOOGLE_CONNECTOR_CLIENT_ID: 'production-contacts', GOOGLE_CONNECTOR_CLIENT_SECRET: 'production-contacts-secret',
    GOOGLE_CALENDAR_CLIENT_ID: 'production-calendar', GOOGLE_CALENDAR_CLIENT_SECRET: 'production-calendar-secret',
    GOOGLE_CALENDAR_PUBLISH_CLIENT_ID: 'production-publish', GOOGLE_CALENDAR_PUBLISH_CLIENT_SECRET: 'production-publish-secret',
    GOOGLE_PROJECT_ID: 'production-login-project', CONNECTOR_TOKEN_KEYRING: 'production-vault',
    BETTER_AUTH_SECRET: 'production-session-secret', UNRELATED_SETTING: 'preserved',
  };
  const environment = cloudDevelopmentEnvironment({}, inherited);
  assert.equal(environment.UNRELATED_SETTING, 'preserved');
  for (const name of Object.keys(inherited).filter((name) => name !== 'UNRELATED_SETTING')) assert.equal(environment[name], '');
  assert.equal(developmentConfigurationProblems(environment).length, 3);
  const local = cloudDevelopmentEnvironment({ GOOGLE_GMAIL_CLIENT_ID: 'local-gmail', GOOGLE_GMAIL_CLIENT_SECRET: 'local-gmail-secret' }, inherited);
  assert.equal(local.GOOGLE_GMAIL_CLIENT_ID, 'local-gmail');
  assert.equal(local.GOOGLE_GMAIL_CLIENT_SECRET, 'local-gmail-secret');
  assert.equal(local.GOOGLE_CLIENT_ID, '');
});
