import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import test from 'node:test';
import { ensureDevelopmentEnvironment } from '../scripts/development.mjs';
import { importGoogleDevelopmentClient } from '../scripts/import-google-development.mjs';

function exportedClient(purpose = 'login', client = 'development-login', project = 'everclose-dev-login') {
  return { web: {
    client_id: `${client}.apps.googleusercontent.com`, client_secret: 'GOCSPX_private-fixture-never-log',
    project_id: project, auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    redirect_uris: [`http://localhost:3100${purpose === 'login' ? '/api/auth/callback/google' : '/api/connections/google/callback'}`],
    javascript_origins: ['http://localhost:3100'],
  } };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'everclose-google-import-'));
  await copyFile(new URL('../.env.development.example', import.meta.url), join(root, '.env.development.example'));
  await ensureDevelopmentEnvironment(root);
  const env = join(root, '.env.development.local');
  const file = join(root, 'client.json');
  return { root, env, file, write: (value: unknown) => writeFile(file, JSON.stringify(value)), close: () => rm(root, { recursive: true, force: true }) };
}

test('Google Web export imports only private local credentials and preserves the vault and existing settings', async () => {
  const f = await fixture();
  try {
    const before = parseEnv(await readFile(f.env, 'utf8'));
    await f.write(exportedClient());
    assert.deepEqual(await importGoogleDevelopmentClient({ purpose: 'login', file: f.file, root: f.root }), { purpose: 'login', changed: true });
    const firstText = await readFile(f.env, 'utf8');
    const first = parseEnv(firstText);
    assert.equal(first.GOOGLE_CLIENT_ID, 'development-login.apps.googleusercontent.com');
    assert.equal(first.GOOGLE_PROJECT_ID, 'everclose-dev-login');
    assert.equal(first.GOOGLE_CLIENT_SECRET, 'GOCSPX_private-fixture-never-log');
    assert.equal(first.BETTER_AUTH_SECRET, before.BETTER_AUTH_SECRET);
    assert.equal(first.CONNECTOR_TOKEN_KEYRING, before.CONNECTOR_TOKEN_KEYRING);
    assert.equal((await stat(f.env)).mode & 0o777, 0o600);
    assert.equal((await importGoogleDevelopmentClient({ purpose: 'login', file: f.file, root: f.root })).changed, false);
    assert.equal(await readFile(f.env, 'utf8'), firstText);

    for (const [purpose, prefix] of [
      ['contacts', 'GOOGLE_CONNECTOR'], ['calendar', 'GOOGLE_CALENDAR'],
      ['calendar-publish', 'GOOGLE_CALENDAR_PUBLISH'], ['gmail', 'GOOGLE_GMAIL'],
    ]) {
      await f.write(exportedClient(purpose, `development-${purpose}`, 'everclose-dev-connections'));
      await importGoogleDevelopmentClient({ purpose, file: f.file, root: f.root });
      const current = parseEnv(await readFile(f.env, 'utf8'));
      assert.equal(current[`${prefix}_CLIENT_ID`], `development-${purpose}.apps.googleusercontent.com`);
      assert.equal(current.GOOGLE_CLIENT_ID, first.GOOGLE_CLIENT_ID);
      assert.equal(current.BETTER_AUTH_SECRET, before.BETTER_AUTH_SECRET);
      assert.equal(current.CONNECTOR_TOKEN_KEYRING, before.CONNECTOR_TOKEN_KEYRING);
    }
  } finally { await f.close(); }
});

test('Google import rejects production/shared callbacks and unsafe exports without changing local secrets', async () => {
  const f = await fixture();
  try {
    const original = await readFile(f.env, 'utf8');
    const invalid = [
      { installed: exportedClient().web },
      { web: { ...exportedClient().web, redirect_uris: ['https://everclosecrm.com/api/auth/callback/google'] } },
      { web: { ...exportedClient().web, redirect_uris: [...exportedClient().web.redirect_uris, 'https://everclosecrm.com/api/auth/callback/google'] } },
      { web: { ...exportedClient().web, javascript_origins: ['https://everclosecrm.com'] } },
      { web: { ...exportedClient().web, auth_uri: 'https://example.invalid/auth' } },
      { web: { ...exportedClient().web, token_uri: 'https://example.invalid/token' } },
      { web: { ...exportedClient().web, client_secret: 'unsafe\nGOOGLE_CLIENT_ID=changed' } },
      { web: { ...exportedClient().web, client_id: 'invalid-client' } },
      { web: { ...exportedClient().web, project_id: 'not a project' } },
    ];
    for (const value of invalid) {
      await f.write(value);
      await assert.rejects(importGoogleDevelopmentClient({ purpose: 'login', file: f.file, root: f.root }));
      assert.equal(await readFile(f.env, 'utf8'), original);
    }
    await f.write(exportedClient('contacts'));
    await assert.rejects(importGoogleDevelopmentClient({ purpose: 'login', file: f.file, root: f.root }), /dedicated localhost/);
    await writeFile(f.file, 'x'.repeat(65537));
    await assert.rejects(importGoogleDevelopmentClient({ purpose: 'login', file: f.file, root: f.root }), /could not be read safely/);
    assert.equal(await readFile(f.env, 'utf8'), original);
  } finally { await f.close(); }
});

test('Google import enforces distinct purpose clients and separates data grants from the local login project', async () => {
  const f = await fixture();
  try {
    await f.write(exportedClient('contacts', 'development-contacts', 'everclose-dev-connections'));
    await assert.rejects(importGoogleDevelopmentClient({ purpose: 'contacts', file: f.file, root: f.root }), /sign-in client first/);
    await f.write(exportedClient());
    await importGoogleDevelopmentClient({ purpose: 'login', file: f.file, root: f.root });
    const before = await readFile(f.env, 'utf8');
    await f.write(exportedClient('contacts', 'development-login', 'everclose-dev-connections'));
    await assert.rejects(importGoogleDevelopmentClient({ purpose: 'contacts', file: f.file, root: f.root }), /already used/);
    await f.write(exportedClient('contacts', 'development-contacts', 'everclose-dev-login'));
    await assert.rejects(importGoogleDevelopmentClient({ purpose: 'contacts', file: f.file, root: f.root }), /separate Google projects/);
    assert.equal(await readFile(f.env, 'utf8'), before);
  } finally { await f.close(); }
});

test('Google import refuses symlink destinations and duplicate or multiline-conflicting keys', async () => {
  const f = await fixture();
  try {
    await f.write(exportedClient());
    const original = await readFile(f.env, 'utf8');
    await writeFile(f.env, original + '\nGOOGLE_CLIENT_ID=duplicate\n');
    const duplicated = await readFile(f.env, 'utf8');
    await assert.rejects(importGoogleDevelopmentClient({ purpose: 'login', file: f.file, root: f.root }), /duplicate credential keys/);
    assert.equal(await readFile(f.env, 'utf8'), duplicated);
    const multiline = original.replace('GOOGLE_CLIENT_ID=', '# missing login key') + '\nUNRELATED="private-line\nGOOGLE_CLIENT_ID=inside-unrelated-value\n"\n';
    await writeFile(f.env, multiline);
    await assert.rejects(importGoogleDevelopmentClient({ purpose: 'login', file: f.file, root: f.root }), /unrelated values/);
    assert.equal(await readFile(f.env, 'utf8'), multiline);
    const saved = join(f.root, 'saved.env');
    await writeFile(saved, original);
    await rm(f.env);
    await symlink(saved, f.env);
    await assert.rejects(importGoogleDevelopmentClient({ purpose: 'login', file: f.file, root: f.root }), /regular file/);
    assert.equal(await readFile(saved, 'utf8'), original);
  } finally { await f.close(); }
});

test('Google import CLI never prints a malformed export or credential secret', async () => {
  const f = await fixture();
  try {
    const sentinel = 'private-export-value-never-print';
    await writeFile(f.file, `{"web":{"client_secret":"${sentinel}"`);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/import-google-development.mjs', import.meta.url)), '--purpose', 'login', '--file', f.file], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /valid Google Web application client export/);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(sentinel));
    const invalidArgs = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/import-google-development.mjs', import.meta.url)), '--secret', sentinel], { encoding: 'utf8' });
    assert.equal(invalidArgs.status, 1);
    assert.ok(!`${invalidArgs.stdout}${invalidArgs.stderr}`.includes(sentinel));
  } finally { await f.close(); }
});
