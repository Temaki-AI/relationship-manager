import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  decryptPortableBackup,
  encryptPortableBackup,
  isPortableBackup,
} from '../lib/portable-backup.ts';
import { SCOPED_IMPORT_MINUTE_ATTEMPTS } from '../lib/integration-protection.ts';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const standaloneRoot = join(projectRoot, '.next', 'standalone');
const standaloneServer = join(standaloneRoot, 'server.js');
const smokePassword = 'bonds-production-smoke-password';
const smokeSessionSecret = 'bonds-production-smoke-session-secret-123456789';
const smokeApiToken = 'bonds-production-smoke-api-token-123456789';
const portableBackupPassphrase = 'production smoke portable backup phrase';
const tinyPngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function getOpenPort() {
  const server = createServer();
  server.unref();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const { port } = address;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function stopServer(server) {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([once(server, 'exit'), delay(5_000)]);
  if (server.exitCode === null) {
    server.kill('SIGKILL');
    await once(server, 'exit');
  }
}

async function waitForServer(baseUrl, server, getOutput) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Production server exited before becoming ready.\n${getOutput()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health/ready`);
      if (response.status === 200) return;
    } catch {
      // The listener is expected to refuse connections briefly during startup.
    }
    await delay(100);
  }
  throw new Error(`Production server did not become ready.\n${getOutput()}`);
}

async function expectJson(response, expectedStatus) {
  if (response.status !== expectedStatus) {
    const body = await response.text();
    assert.equal(response.status, expectedStatus, body);
  }
  assert.match(response.headers.get('content-type') || '', /^application\/(?:[a-z0-9.-]+\+)?json\b/i);
  return response.json();
}

function expectRequestId(response) {
  const requestId = response.headers.get('x-request-id') || '';
  assert.match(requestId, requestIdPattern);
  return requestId;
}

function parseStructuredLogs(output) {
  return output.split('\n').flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value && typeof value.event === 'string' && typeof value.level === 'string'
        ? [value]
        : [];
    } catch {
      return [];
    }
  });
}

async function expectNonceProtectedHtml(response, expectedStatus = 200) {
  assert.equal(response.status, expectedStatus);
  const policy = response.headers.get('content-security-policy') || '';
  const nonce = policy.match(/script-src[^;]*'nonce-([^']+)'/)?.[1];
  assert(nonce, policy);
  const scriptDirective = policy.split(';').find((directive) => directive.trim().startsWith('script-src '));
  assert(scriptDirective);
  assert.match(scriptDirective, /'strict-dynamic'/);
  assert.doesNotMatch(scriptDirective, /'unsafe-inline'|'unsafe-eval'/);
  assert.match(policy, /script-src-attr 'none'/);
  assert.match(policy, /img-src 'self' data: blob:/);
  assert.doesNotMatch(policy, /img-src[^;]*https:/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.equal(response.headers.get('x-nonce'), null);

  const html = await response.text();
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map(([tag]) => tag);
  assert(scripts.length > 0, html.slice(0, 500));
  for (const script of scripts) {
    assert(script.includes(`nonce="${nonce}"`), script);
  }
  return { nonce, policy, html };
}

test('optimized production server supports the critical consumer journey', { timeout: 45_000 }, async () => {
  await access(standaloneServer);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'bonds-production-smoke-'));
  const port = await getOpenPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;
  let output = '';

  try {
    server = spawn(process.execPath, [standaloneServer], {
      cwd: standaloneRoot,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        HOSTNAME: '127.0.0.1',
        PORT: String(port),
        CRM_PASSWORD: smokePassword,
        CRM_SESSION_SECRET: smokeSessionSecret,
        CRM_SESSION_TTL_HOURS: '24',
        CRM_API_TOKEN: smokeApiToken,
        CRM_DATABASE_PATH: join(temporaryRoot, 'relationships.db'),
        CRM_BACKUP_DIRECTORY: join(temporaryRoot, 'backups'),
        CRM_BACKUP_RETENTION_COUNT: '5',
        CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS: '24',
        CRM_TRUST_PROXY_HEADERS: 'true',
        CRM_LOG_LEVEL: 'info',
        SEED_DEMO_DATA: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const appendOutput = (chunk) => {
      output = `${output}${chunk.toString()}`.slice(-20_000);
    };
    server.stdout.on('data', appendOutput);
    server.stderr.on('data', appendOutput);
    await waitForServer(baseUrl, server, () => output);

    const databaseFiles = (await readdir(temporaryRoot))
      .filter((filename) => filename.startsWith('relationships.db'));
    assert(databaseFiles.includes('relationships.db'));
    for (const filename of databaseFiles) {
      assert.equal((await stat(join(temporaryRoot, filename))).mode & 0o777, 0o600, filename);
    }
    const backupDirectoryPath = join(temporaryRoot, 'backups');
    assert.equal((await stat(backupDirectoryPath)).mode & 0o777, 0o700);
    for (const filename of await readdir(backupDirectoryPath)) {
      assert.equal((await stat(join(backupDirectoryPath, filename))).mode & 0o777, 0o600, filename);
    }

    const liveness = await expectJson(await fetch(`${baseUrl}/api/health/live`), 200);
    assert.deepEqual(liveness, { status: 'alive' });

    const healthResponse = await fetch(`${baseUrl}/api/health`, {
      headers: {
        Origin: 'https://bonds.example.test',
        'X-Forwarded-Host': 'bonds.example.test',
        'X-Forwarded-Proto': 'https',
        'X-Request-ID': 'attacker-controlled-id',
      },
    });
    const healthRequestId = expectRequestId(healthResponse);
    assert.notEqual(healthRequestId, 'attacker-controlled-id');
    const health = await expectJson(healthResponse, 200);
    assert.equal(health.status, 'ok');
    assert.equal(health.ready, true);
    assert.equal(health.checks.authentication, 'enabled');
    assert.equal(health.checks.backup, 'current');
    assert.equal(healthResponse.headers.get('access-control-allow-origin'), 'https://bonds.example.test');
    assert.match(healthResponse.headers.get('access-control-expose-headers') || '', /X-Request-ID/);
    assert.match(healthResponse.headers.get('strict-transport-security') || '', /max-age=31536000/);
    assert.equal(
      healthResponse.headers.get('x-robots-tag'),
      'noindex, nofollow, noarchive, nosnippet, noimageindex'
    );
    assert.equal(healthResponse.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(healthResponse.headers.get('x-permitted-cross-domain-policies'), 'none');

    const robotsResponse = await fetch(`${baseUrl}/robots.txt`);
    assert.equal(robotsResponse.status, 200);
    assert.match(robotsResponse.headers.get('content-type') || '', /^text\/plain/);
    assert.equal(robotsResponse.headers.get('x-robots-tag')?.includes('noindex'), true);
    const robots = await robotsResponse.text();
    assert.match(robots, /User-Agent: \*/i);
    assert.match(robots, /Disallow: \//i);

    const signedOutPage = await fetch(`${baseUrl}/contacts`, {
      headers: { Accept: 'text/html' },
      redirect: 'manual',
    });
    assert.notEqual(expectRequestId(signedOutPage), healthRequestId);
    assert.equal(signedOutPage.status, 307);
    const redirectPolicy = signedOutPage.headers.get('content-security-policy') || '';
    const redirectNonce = redirectPolicy.match(/script-src[^;]*'nonce-([^']+)'/)?.[1];
    assert(redirectNonce, redirectPolicy);
    const loginLocation = new URL(signedOutPage.headers.get('location'), baseUrl);
    assert.equal(loginLocation.pathname, '/login');
    assert.equal(loginLocation.searchParams.get('next'), '/contacts');
    const loginPage = await expectNonceProtectedHtml(await fetch(loginLocation, {
      headers: { Accept: 'text/html' },
    }));
    assert.match(loginPage.html, /<meta name="robots" content="noindex, nofollow/i);
    await expectJson(await fetch(`${baseUrl}/api/contacts`), 401);

    const manifestResponse = await fetch(`${baseUrl}/manifest.webmanifest`);
    const manifest = await expectJson(manifestResponse, 200);
    assert.equal(manifest.display, 'standalone');
    assert(manifest.icons.some((icon) => icon.src === '/icons/bonds-192.png'));
    assert.deepEqual(manifest.shortcuts.map((shortcut) => shortcut.url), [
      '/contacts',
      '/contacts/new',
      '/reminders',
    ]);
    const iconResponse = await fetch(`${baseUrl}/icons/bonds-192.png`);
    assert.equal(iconResponse.status, 200);
    assert.equal(iconResponse.headers.get('content-type'), 'image/png');
    const workerResponse = await fetch(`${baseUrl}/sw.js`);
    assert.equal(workerResponse.status, 200);
    assert.match(workerResponse.headers.get('content-type') || '', /javascript/);
    assert.equal(workerResponse.headers.get('service-worker-allowed'), '/');
    assert.equal(workerResponse.headers.get('cache-control'), 'no-store');
    const workerSource = await workerResponse.text();
    assert.match(workerSource, /bonds-public-shell-v1/);
    assert.match(workerSource, /if\s*\(url\.pathname\.startsWith\(['"]\/api\/['"]\)\)\s*return;/);
    const offlineResponse = await fetch(`${baseUrl}/offline.html`);
    assert.equal(offlineResponse.status, 200);
    assert.match(await offlineResponse.text(), /never copied into the offline cache/i);
    const offlineCssResponse = await fetch(`${baseUrl}/offline.css`);
    assert.equal(offlineCssResponse.status, 200);
    assert.match(offlineCssResponse.headers.get('content-type') || '', /text\/css/);

    const loginRequest = (password, clientIp, forwardedProto = 'https') => {
      const headers = {
        'Content-Type': 'application/json',
        'X-Forwarded-For': clientIp,
      };
      if (forwardedProto) headers['X-Forwarded-Proto'] = forwardedProto;
      return fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ password }),
      });
    };
    const oversizedLogin = await expectJson(
      await loginRequest('x'.repeat(4 * 1024), '203.0.113.9'),
      413
    );
    assert.equal(oversizedLogin.error, 'Sign-in payload is too large.');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expectJson(await loginRequest('incorrect-password', '203.0.113.10'), 401);
    }
    const lockedOutResponse = await loginRequest('incorrect-password', '203.0.113.10');
    const lockedOutRequestId = expectRequestId(lockedOutResponse);
    const lockedOut = await expectJson(lockedOutResponse, 429);
    assert(lockedOut.retryAfterSeconds > 0);
    assert.equal(lockedOutResponse.headers.get('retry-after'), String(lockedOut.retryAfterSeconds));

    const localLoginResponse = await loginRequest(smokePassword, '203.0.113.11', null);
    await expectJson(localLoginResponse, 200);
    const localSetCookie = localLoginResponse.headers.get('set-cookie') || '';
    assert.match(localSetCookie, /HttpOnly/i);
    assert.doesNotMatch(localSetCookie, /;\s*Secure(?:;|$)/i);
    assert.equal(localLoginResponse.headers.get('strict-transport-security'), null);

    const loginResponse = await loginRequest(smokePassword, '203.0.113.12');
    const loginRequestId = expectRequestId(loginResponse);
    const login = await expectJson(loginResponse, 200);
    assert.equal(login.authenticated, true);
    const setCookie = loginResponse.headers.get('set-cookie') || '';
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /Max-Age=86400/i);
    assert.match(setCookie, /Priority=High/i);
    assert.match(loginResponse.headers.get('strict-transport-security') || '', /max-age=31536000/);
    const sessionCookie = setCookie.split(';', 1)[0];
    assert.match(sessionCookie, /^bonds_session=/);
    assert.match(sessionCookie, /^bonds_session=v2\./);
    await expectJson(await loginRequest('incorrect-password', '203.0.113.10'), 401);

    const authenticatedFetch = (path, options = {}) => {
      const headers = new Headers(options.headers);
      headers.set('Cookie', sessionCookie);
      if (!headers.has('X-Forwarded-Proto')) headers.set('X-Forwarded-Proto', 'https');
      return fetch(`${baseUrl}${path}`, { ...options, headers, redirect: 'manual' });
    };
    const jsonRequest = (path, method, body, idempotencyKey = randomUUID()) => authenticatedFetch(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(body),
    });
    const apiTokenRequest = (path, method, body) => fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${smokeApiToken}`,
        'Content-Type': 'application/json',
        'X-Forwarded-Proto': 'https',
      },
      body: JSON.stringify(body),
      redirect: 'manual',
    });

    const session = await expectJson(await authenticatedFetch('/api/auth/session'), 200);
    assert.equal(session.authenticated, true);
    assert.equal(session.authenticatedBy, 'session');

    const dataConnections = await expectJson(await authenticatedFetch('/api/integrations'), 200);
    assert.deepEqual(dataConnections.workspace, { name: 'My Everclose CRM', mode: 'local' });
    assert.equal(dataConnections.automaticAccountSync.enabled, false);
    assert.deepEqual(
      dataConnections.capabilities
        .filter((capability) => capability.status === 'available')
        .map((capability) => capability.id),
      ['vcard', 'csv', 'encrypted-backup']
    );
    assert.equal('integrations' in dataConnections, false);

    const maintenanceLockPath = `${backupDirectoryPath}.maintenance.lock`;
    await writeFile(maintenanceLockPath, 'production-maintenance-owner\n', { mode: 0o600 });
    try {
      const blockedMutation = await expectJson(await jsonRequest('/api/contacts', 'POST', {
        name: 'Must not survive maintenance',
        email: 'maintenance-race@example.test',
      }), 409);
      assert.match(blockedMutation.error, /maintenance operation is already running/i);
    } finally {
      await rm(maintenanceLockPath, { force: true });
    }
    const afterBlockedMutation = await expectJson(await authenticatedFetch('/api/stats'), 200);
    assert.equal(afterBlockedMutation.stats.totalContacts, 0);

    const contactsPage = await authenticatedFetch('/contacts', {
      headers: {
        Accept: 'text/html',
        'X-Forwarded-Host': 'bonds.example.test',
        'X-Forwarded-Proto': 'https',
      },
    });
    const protectedPage = await expectNonceProtectedHtml(contactsPage);
    assert.notEqual(protectedPage.nonce, redirectNonce);
    assert.match(protectedPage.policy, /upgrade-insecure-requests$/);

    const missingPageResponse = await authenticatedFetch('/this-page-does-not-exist', {
      headers: {
        Accept: 'text/html',
        'X-Forwarded-Host': 'bonds.example.test',
        'X-Forwarded-Proto': 'https',
      },
    });
    const missingPage = await expectNonceProtectedHtml(missingPageResponse, 404);
    assert.match(missingPage.html, /This connection leads nowhere\./);
    assert.match(missingPage.html, /Your CRM data is safe\./);

    const oversizedChunks = ['{"email":"', 'x'.repeat(256 * 1024), '"}'];
    const oversizedStream = new ReadableStream({
      pull(controller) {
        const chunk = oversizedChunks.shift();
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode(chunk));
      },
    });
    const chunkedOversize = await expectJson(await authenticatedFetch('/api/enrich', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversizedStream,
      duplex: 'half',
    }), 413);
    assert.match(chunkedOversize.error, /256 KB limit/);

    await expectJson(await jsonRequest('/api/contacts', 'POST', { name: ' ' }), 400);
    const missingIdempotencyKey = await expectJson(await authenticatedFetch('/api/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Must require replay protection' }),
    }), 400);
    assert.match(missingIdempotencyKey.error, /Idempotency-Key header is required/);

    const contactInput = {
      name: 'Release Gate Person',
      email: 'release-gate@example.test',
      phone: '+49 30 555 0101',
      photo_url: tinyPngDataUrl,
      birthday: '1990-03-04',
      tags: ['friend', 'smoke'],
      notes: 'Created by the production release gate.',
      contact_frequency: 14,
    };
    const contactCreateKey = randomUUID();
    const contactCreateResponse = await jsonRequest('/api/contacts', 'POST', contactInput, contactCreateKey);
    assert.equal(contactCreateResponse.headers.get('idempotency-replayed'), 'false');
    const created = await expectJson(contactCreateResponse, 201);
    const contactReplayResponse = await jsonRequest('/api/contacts', 'POST', contactInput, contactCreateKey);
    assert.equal(contactReplayResponse.headers.get('idempotency-replayed'), 'true');
    const contactReplay = await expectJson(contactReplayResponse, 201);
    assert.equal(contactReplay.contact.id, created.contact.id);
    const contactKeyConflict = await expectJson(await jsonRequest('/api/contacts', 'POST', {
      ...contactInput,
      name: 'Changed replay payload',
    }, contactCreateKey), 409);
    assert.match(contactKeyConflict.error, /already used for a different create request/);
    const contactId = created.contact.id;
    assert.equal(created.contact.name, 'Release Gate Person');
    assert.equal(created.contact.photo_url, tinyPngDataUrl);

    await expectJson(await fetch(`${baseUrl}/api/contacts`, {
      headers: { Authorization: `Bearer ${smokeApiToken}` },
    }), 403);
    const scopedDuplicate = await expectJson(await apiTokenRequest('/api/import/linkedin', 'POST', {
      fullName: 'Attacker-controlled duplicate label',
      email: 'release-gate@example.test',
      notes: 'Input controlled by the integration client.',
      linkedinUrl: 'https://www.linkedin.com/in/release-gate-person',
    }), 200);
    assert.equal(scopedDuplicate.duplicate, true);
    assert.deepEqual(scopedDuplicate.contact, {
      id: contactId,
      name: 'Release Gate Person',
    });
    const scopedDuplicatePayload = JSON.stringify(scopedDuplicate);
    assert.equal(scopedDuplicatePayload.includes('Created by the production release gate.'), false);
    assert.equal(scopedDuplicatePayload.includes(tinyPngDataUrl), false);

    const initialDetail = await expectJson(
      await authenticatedFetch(`/api/contacts/${contactId}`),
      200
    );
    assert.match(initialDetail.contact.edit_revision, /^[a-f0-9]{64}$/);

    const revisionRequired = await expectJson(await jsonRequest(`/api/contacts/${contactId}`, 'PATCH', {
      notes: 'An edit without a loaded revision must not be accepted.',
    }), 428);
    assert.match(revisionRequired.error, /refresh this contact/i);

    const updated = await expectJson(await jsonRequest(`/api/contacts/${contactId}`, 'PATCH', {
      notes: 'Updated through the optimized production server.',
      contact_frequency: 21,
      expected_edit_revision: initialDetail.contact.edit_revision,
    }), 200);
    assert.equal(updated.contact.contact_frequency, 21);
    assert.notEqual(updated.contact.edit_revision, initialDetail.contact.edit_revision);

    const competingEdits = await Promise.all([
      jsonRequest(`/api/contacts/${contactId}`, 'PATCH', {
        notes: 'Concurrent edit A won.',
        expected_edit_revision: updated.contact.edit_revision,
      }),
      jsonRequest(`/api/contacts/${contactId}`, 'PATCH', {
        notes: 'Concurrent edit B won.',
        expected_edit_revision: updated.contact.edit_revision,
      }),
    ]);
    assert.deepEqual(competingEdits.map((response) => response.status).sort(), [200, 409]);
    const winningEdit = await expectJson(
      competingEdits.find((response) => response.status === 200),
      200
    );
    const staleUpdate = await expectJson(
      competingEdits.find((response) => response.status === 409),
      409
    );
    assert.match(staleUpdate.error, /draft has not been saved/i);
    const afterStaleUpdate = await expectJson(
      await authenticatedFetch(`/api/contacts/${contactId}`),
      200
    );
    assert.equal(afterStaleUpdate.contact.notes, winningEdit.contact.notes);

    const today = new Date().toISOString().slice(0, 10);
    const interactionInput = {
      contact_id: contactId,
      date: today,
      type: 'message',
      summary: 'Production smoke check-in',
    };
    const interactionCreateKey = randomUUID();
    const interactionResponse = await jsonRequest('/api/interactions', 'POST', interactionInput, interactionCreateKey);
    assert.equal(interactionResponse.headers.get('idempotency-replayed'), 'false');
    const interaction = await expectJson(interactionResponse, 201);
    const interactionReplayResponse = await jsonRequest('/api/interactions', 'POST', interactionInput, interactionCreateKey);
    assert.equal(interactionReplayResponse.headers.get('idempotency-replayed'), 'true');
    assert.equal((await expectJson(interactionReplayResponse, 201)).interaction.id, interaction.interaction.id);
    assert.equal(interaction.interaction.contact_id, contactId);

    const dueReminderAt = new Date(Date.now() - 60_000);
    const dueReminderInput = new Date(dueReminderAt.getTime() + 2 * 60 * 60 * 1_000)
      .toISOString()
      .replace('Z', '+02:00');
    const reminderInput = {
      contact_id: contactId,
      title: 'Follow up after smoke test',
      remind_at: dueReminderInput,
    };
    const reminderCreateKey = randomUUID();
    const reminderResponse = await jsonRequest('/api/reminders', 'POST', reminderInput, reminderCreateKey);
    assert.equal(reminderResponse.headers.get('idempotency-replayed'), 'false');
    const reminder = await expectJson(reminderResponse, 201);
    const reminderReplayResponse = await jsonRequest('/api/reminders', 'POST', reminderInput, reminderCreateKey);
    assert.equal(reminderReplayResponse.headers.get('idempotency-replayed'), 'true');
    assert.equal((await expectJson(reminderReplayResponse, 201)).reminder.id, reminder.reminder.id);
    assert.equal(reminder.reminder.contact_id, contactId);
    assert.equal(reminder.reminder.remind_at, dueReminderAt.toISOString());

    const planInput = {
      contact_id: contactId,
      type: 'call',
      planned_date: '2030-01-15',
      summary: 'Production history paging plan',
    };
    const planCreateKey = randomUUID();
    const planResponse = await jsonRequest('/api/plans', 'POST', planInput, planCreateKey);
    assert.equal(planResponse.headers.get('idempotency-replayed'), 'false');
    const plan = await expectJson(planResponse, 201);
    const planReplayResponse = await jsonRequest('/api/plans', 'POST', planInput, planCreateKey);
    assert.equal(planReplayResponse.headers.get('idempotency-replayed'), 'true');
    assert.equal((await expectJson(planReplayResponse, 201)).plan.id, plan.plan.id);
    assert.equal(plan.plan.contact_id, contactId);

    const openPlanPage = await expectJson(
      await authenticatedFetch('/api/plans?page=1&pageSize=1'),
      200
    );
    assert.equal(openPlanPage.plans.length, 1);
    assert.deepEqual(openPlanPage.pagination, {
      page: 1,
      pageSize: 1,
      total: 1,
      totalPages: 1,
    });
    const contactPlanPage = await expectJson(
      await authenticatedFetch(`/api/plans?contact_id=${contactId}&status=all&pageSize=1`),
      200
    );
    assert.equal(contactPlanPage.pagination.total, 1);
    await expectJson(await authenticatedFetch('/api/plans?status=unknown'), 400);

    const numericGroup = await expectJson(await jsonRequest('/api/groups', 'POST', {
      name: 'Production compatibility group',
      color: '#e11d48',
    }), 201);
    const numericGroupId = numericGroup.group.id;
    const numericMember = await expectJson(
      await jsonRequest(`/api/groups/${numericGroupId}/members`, 'POST', { contact_id: contactId }),
      200
    );
    assert.equal(numericMember.added, true);
    const numericGroups = await expectJson(
      await authenticatedFetch('/api/groups?page=1&pageSize=1'),
      200
    );
    assert.equal(numericGroups.groups.length, 1);
    assert.equal(numericGroups.groups[0].member_count, 1);
    assert.equal(numericGroups.pagination.total, 1);
    const numericGroupDetail = await expectJson(
      await authenticatedFetch(`/api/groups/${numericGroupId}?page=1&pageSize=1`),
      200
    );
    assert.equal(numericGroupDetail.members.length, 1);
    assert.equal(numericGroupDetail.pagination.total, 1);

    const notificationReminderView = await expectJson(
      await authenticatedFetch('/api/reminders?view=notifications'),
      200
    );
    assert.deepEqual(
      Object.keys(notificationReminderView.reminders[0]).sort(),
      ['id', 'remind_at']
    );
    const notificationPayload = JSON.stringify(notificationReminderView);
    assert.equal(notificationPayload.includes('Release Gate Person'), false);
    assert.equal(notificationPayload.includes('Follow up after smoke test'), false);

    const reminderPage = await expectJson(
      await authenticatedFetch('/api/reminders?page=1&pageSize=1'),
      200
    );
    assert.equal(reminderPage.reminders.length, 1);
    assert.deepEqual(reminderPage.pagination, {
      page: 1,
      pageSize: 1,
      total: 1,
      totalPages: 1,
    });

    const detail = await expectJson(await authenticatedFetch(`/api/contacts/${contactId}`), 200);
    assert.equal(detail.contact.last_contacted, today);
    assert.equal(detail.interactions.length, 1);
    assert.equal(detail.reminders.length, 1);
    assert.equal(detail.plans.length, 1);
    assert.equal(detail.history.interactions.total, 1);
    assert.equal(detail.history.reminders.total, 1);
    assert.equal(detail.history.facts.total, 0);
    assert.equal(detail.history.plans.total, 1);
    assert.equal(detail.history.timeline.total, 2);
    assert.equal(detail.timeline.length, 2);
    assert.match(detail.interactions[0].edit_revision, /^[a-f0-9]{64}$/);

    const interactionRevisionRequired = await expectJson(
      await jsonRequest(`/api/interactions/${interaction.interaction.id}`, 'PATCH', {
        date: today,
        type: 'message',
        summary: 'Must not save without a loaded revision.',
        notes: null,
      }),
      428
    );
    assert.match(interactionRevisionRequired.error, /refresh this interaction/i);

    const competingInteractionEdits = await Promise.all([
      jsonRequest(`/api/interactions/${interaction.interaction.id}`, 'PATCH', {
        date: today,
        type: 'message',
        summary: 'Concurrent interaction edit A won.',
        notes: null,
        expected_edit_revision: detail.interactions[0].edit_revision,
      }),
      jsonRequest(`/api/interactions/${interaction.interaction.id}`, 'PATCH', {
        date: today,
        type: 'message',
        summary: 'Concurrent interaction edit B won.',
        notes: null,
        expected_edit_revision: detail.interactions[0].edit_revision,
      }),
    ]);
    assert.deepEqual(competingInteractionEdits.map((response) => response.status).sort(), [200, 409]);
    const winningInteractionEdit = await expectJson(
      competingInteractionEdits.find((response) => response.status === 200),
      200
    );
    const staleInteractionEdit = await expectJson(
      competingInteractionEdits.find((response) => response.status === 409),
      409
    );
    assert.match(staleInteractionEdit.error, /draft has not been saved/i);
    const detailAfterInteractionRace = await expectJson(
      await authenticatedFetch(`/api/contacts/${contactId}`),
      200
    );
    assert.equal(
      detailAfterInteractionRace.interactions[0].summary,
      winningInteractionEdit.interaction.summary
    );

    const interactionHistory = await expectJson(
      await authenticatedFetch(`/api/contacts/${contactId}?view=interactions&page=1&pageSize=1`),
      200
    );
    assert.equal(interactionHistory.interactions.length, 1);
    assert.deepEqual(interactionHistory.pagination, {
      page: 1,
      pageSize: 1,
      total: 1,
      totalPages: 1,
    });
    const reminderHistory = await expectJson(
      await authenticatedFetch(`/api/contacts/${contactId}?view=reminders&pageSize=1`),
      200
    );
    assert.equal(reminderHistory.reminders.length, 1);
    assert.equal(reminderHistory.pagination.total, 1);
    const planHistory = await expectJson(
      await authenticatedFetch(`/api/contacts/${contactId}?view=plans&pageSize=1`),
      200
    );
    assert.equal(planHistory.plans.length, 1);
    assert.equal(planHistory.pagination.total, 1);
    const factHistory = await expectJson(
      await authenticatedFetch(`/api/contacts/${contactId}?view=facts&pageSize=1`),
      200
    );
    assert.deepEqual(factHistory.facts, []);
    assert.equal(factHistory.pagination.total, 0);
    const timelineHistory = await expectJson(
      await authenticatedFetch(`/api/contacts/${contactId}?view=timeline&page=1&pageSize=1`),
      200
    );
    assert.equal(timelineHistory.timeline.length, 1);
    assert.equal(timelineHistory.pagination.total, 2);
    assert.deepEqual(
      Object.keys(timelineHistory.timeline[0]).sort(),
      ['date', 'id', 'kind', 'summary', 'title', 'tone']
    );
    await expectJson(
      await authenticatedFetch(`/api/contacts/${contactId}?view=unknown`),
      400
    );

    const statsAfterCreate = await expectJson(await authenticatedFetch('/api/stats'), 200);
    assert.equal(statsAfterCreate.stats.totalContacts, 1);
    assert.equal(statsAfterCreate.stats.conversationsThisWeek, 1);

    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Release Gate Duplicate',
      'EMAIL:release-gate@example.test',
      'END:VCARD',
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Imported Production Contact',
      'EMAIL:imported-production@example.test',
      'TEL:+49 30 555 0102',
      'CATEGORIES:customer,smoke',
      'END:VCARD',
      '',
    ].join('\r\n');
    const importForm = () => {
      const form = new FormData();
      form.set('file', new File([vcard], 'production-smoke.vcf', { type: 'text/vcard' }));
      return form;
    };
    const firstImport = await expectJson(await authenticatedFetch('/api/import/vcard', {
      method: 'POST',
      body: importForm(),
    }), 201);
    assert.deepEqual(
      { imported: firstImport.imported, duplicates: firstImport.skippedDuplicates, total: firstImport.total },
      { imported: 1, duplicates: 1, total: 2 }
    );

    const repeatImport = await expectJson(await authenticatedFetch('/api/import/vcard', {
      method: 'POST',
      body: importForm(),
    }), 200);
    assert.deepEqual(
      { imported: repeatImport.imported, duplicates: repeatImport.skippedDuplicates },
      { imported: 0, duplicates: 2 }
    );

    const firstContactPage = await expectJson(
      await authenticatedFetch('/api/contacts?page=1&pageSize=1'),
      200
    );
    assert.equal(firstContactPage.contacts.length, 1);
    assert.deepEqual(firstContactPage.pagination, {
      page: 1,
      pageSize: 1,
      total: 2,
      totalPages: 2,
    });
    assert.equal(firstContactPage.overallTotal, 2);
    assert.equal('tags' in firstContactPage, false);
    const secondContactPage = await expectJson(
      await authenticatedFetch('/api/contacts?page=2&pageSize=1'),
      200
    );
    assert.equal(secondContactPage.contacts.length, 1);
    assert.notEqual(secondContactPage.contacts[0].id, firstContactPage.contacts[0].id);

    const mentionOptions = await expectJson(
      await authenticatedFetch('/api/contacts?view=mentions&search=release&limit=6'),
      200
    );
    assert.equal(mentionOptions.contacts.length, 1);
    assert.deepEqual(
      Object.keys(mentionOptions.contacts[0]).sort(),
      ['email', 'id', 'name', 'photo_url']
    );
    assert.equal(mentionOptions.contacts[0].photo_url, null);
    assert.equal(JSON.stringify(mentionOptions).includes('Created by the production release gate.'), false);

    const contactTags = await expectJson(
      await authenticatedFetch('/api/contacts?view=tags&pageSize=100'),
      200
    );
    assert(contactTags.tags.some((tag) => tag.tag === 'smoke' && tag.contactCount === 2));
    const tagGroups = await expectJson(await authenticatedFetch('/api/groups/tags'), 200);
    assert(tagGroups.tags.some((tag) => tag.tag === 'smoke' && tag.contactCount === 2));
    const smokeMembers = await expectJson(
      await authenticatedFetch('/api/groups/tags/contacts?tag=smoke&membership=members&pageSize=1'),
      200
    );
    assert.equal(smokeMembers.contacts.length, 1);
    assert.equal(smokeMembers.pagination.total, 2);
    assert.deepEqual(Object.keys(smokeMembers.contacts[0]).sort(), ['email', 'id', 'name']);

    const importedLookup = await expectJson(
      await authenticatedFetch('/api/contacts?search=Imported%20Production%20Contact'),
      200
    );
    assert.equal(importedLookup.contacts.length, 1);
    const importedContactId = importedLookup.contacts[0].id;
    const bulkTagAdd = await expectJson(await jsonRequest('/api/contacts/bulk', 'POST', {
      operation: 'add_tag',
      contactIds: [contactId, importedContactId],
      tag: ' Priority   Circle ',
    }), 200);
    assert.equal(bulkTagAdd.affected, 2);
    const bulkTagDuplicate = await expectJson(await jsonRequest('/api/contacts/bulk', 'POST', {
      operation: 'add_tag',
      contactIds: [contactId, importedContactId],
      tag: 'priority circle',
    }), 200);
    assert.equal(bulkTagDuplicate.affected, 0);
    const bulkTagRemove = await expectJson(await jsonRequest('/api/contacts/bulk', 'POST', {
      operation: 'remove_tag',
      contactIds: [contactId, importedContactId],
      tag: 'PRIORITY CIRCLE',
    }), 200);
    assert.equal(bulkTagRemove.affected, 2);
    await expectJson(await jsonRequest('/api/contacts/bulk', 'POST', {
      operation: 'add_tag',
      contactIds: [contactId],
      tag: 'ambiguous,tag',
    }), 400);
    const addToFriendGroup = await expectJson(
      await jsonRequest('/api/groups/tags/contacts', 'POST', {
        tag: 'friend',
        contactIds: [importedContactId],
      }),
      200
    );
    assert.equal(addToFriendGroup.affected, 1);
    const friendMembers = await expectJson(
      await authenticatedFetch('/api/groups/tags/contacts?tag=friend&membership=members'),
      200
    );
    assert.equal(friendMembers.pagination.total, 2);

    const duplicate = await expectJson(await jsonRequest('/api/contacts', 'POST', {
      name: 'Release Gate Person Duplicate',
      email: 'release-gate-secondary@example.test',
      phone: '+49 (30) 555-0101',
      notes: 'History from the duplicate profile.',
      tags: ['legacy'],
    }), 201);
    const duplicateId = duplicate.contact.id;
    await expectJson(await jsonRequest('/api/interactions', 'POST', {
      contact_id: duplicateId,
      date: today,
      type: 'call',
      summary: 'History that must move during merge',
    }), 201);

    const duplicateReview = await expectJson(await authenticatedFetch('/api/contacts/duplicates'), 200);
    assert.equal(duplicateReview.groupCount, 1);
    assert.equal(duplicateReview.contactCount, 2);
    assert.equal(duplicateReview.truncatedGroupCount, 0);
    assert.deepEqual(duplicateReview.pagination, {
      page: 1,
      pageSize: 10,
      total: 1,
      totalPages: 1,
    });
    assert.equal(duplicateReview.groups[0].totalContacts, 2);
    assert.equal(duplicateReview.groups[0].hasMoreContacts, false);
    assert.deepEqual(
      duplicateReview.groups[0].contacts.map((contact) => contact.id).sort((left, right) => left - right),
      [contactId, duplicateId].sort((left, right) => left - right)
    );

    const mergeResponse = await jsonRequest('/api/contacts/duplicates', 'POST', {
      primaryId: contactId,
      duplicateIds: [duplicateId],
    });
    const mergeRequestId = expectRequestId(mergeResponse);
    const merged = await expectJson(mergeResponse, 200);
    assert.equal(merged.contact.id, contactId);
    assert.equal(merged.moved.interactions, 1);
    assert.match(merged.recoveryPoint.filename, /^bonds-pre-merge-/);
    assert.equal(merged.remaining.groupCount, 0);

    const detailAfterMerge = await expectJson(await authenticatedFetch(`/api/contacts/${contactId}`), 200);
    assert.equal(detailAfterMerge.interactions.length, 2);
    assert.equal(detailAfterMerge.contact.notes.includes(winningEdit.contact.notes), true);
    assert.match(detailAfterMerge.contact.notes, /History from the duplicate profile/);
    const mergedCustomFields = JSON.parse(detailAfterMerge.contact.custom_fields);
    assert.deepEqual(mergedCustomFields.vcard.additional_emails, ['release-gate-secondary@example.test']);
    assert.equal(mergedCustomFields._bonds.merge_history[0].source_contact_id, duplicateId);
    const secondInteractionPage = await expectJson(
      await authenticatedFetch(`/api/contacts/${contactId}?view=interactions&page=2&pageSize=1`),
      200
    );
    assert.equal(secondInteractionPage.interactions.length, 1);
    assert.equal(secondInteractionPage.pagination.total, 2);
    assert.notEqual(secondInteractionPage.interactions[0].id, detailAfterMerge.interactions[0].id);

    const intelligenceOverview = await expectJson(
      await authenticatedFetch('/api/intelligence/overview'),
      200
    );
    assert.equal(intelligenceOverview.stats.totalContacts, 2);
    assert.equal(intelligenceOverview.stats.openReminderCount, 1);
    assert.equal(intelligenceOverview.smartLists.length, 5);
    assert(Array.isArray(intelligenceOverview.feed));
    assert.equal(
      JSON.stringify(intelligenceOverview).includes('Updated through the optimized production server.'),
      false
    );
    const smartLists = await expectJson(await authenticatedFetch('/api/smart-lists'), 200);
    assert.equal(smartLists.smartLists.length, 5);
    assert(smartLists.smartLists.some((list) => list.id === 'dormant-strong-ties'));

    const backupReview = await expectJson(await authenticatedFetch('/api/settings/backups'), 200);
    assert.equal(backupReview.automaticBackup.state, 'current');
    assert(backupReview.backups.some((backup) => backup.reason === 'automatic'));
    assert(backupReview.backups.some((backup) => (
      backup.filename === merged.recoveryPoint.filename && backup.reason === 'pre-merge'
    )));

    const manualBackupResponse = await authenticatedFetch('/api/settings/backups', { method: 'POST' });
    const manualBackupRequestId = expectRequestId(manualBackupResponse);
    const manualBackup = await expectJson(manualBackupResponse, 201);
    assert.equal(manualBackup.backup.reason, 'manual');
    const rawBackupResponse = await authenticatedFetch(
      `/api/settings/backups/${encodeURIComponent(manualBackup.backup.filename)}`
    );
    assert.equal(rawBackupResponse.status, 200);
    const rawBackup = await rawBackupResponse.arrayBuffer();
    assert.equal(rawBackup.byteLength, manualBackup.backup.sizeBytes);
    const encryptedPortableBackup = await encryptPortableBackup(
      rawBackup,
      portableBackupPassphrase
    );
    assert.equal(isPortableBackup(encryptedPortableBackup), true);

    const exportResponse = await authenticatedFetch('/api/export/vcard');
    assert.equal(exportResponse.status, 200);
    assert.match(exportResponse.headers.get('content-type') || '', /^text\/vcard/);
    assert.match(exportResponse.headers.get('content-disposition') || '', /attachment/);
    assert.equal(exportResponse.headers.get('content-length'), null);
    const exportedVCard = await exportResponse.text();
    assert.match(exportedVCard, /FN:Release Gate Person/);
    assert.match(exportedVCard, /PHOTO;ENCODING=b;TYPE=PNG:/);
    assert.match(exportedVCard, /EMAIL;TYPE=OTHER:release-gate-secondary@example\.test/);
    assert.match(exportedVCard, /FN:Imported Production Contact/);

    const csvExportResponse = await authenticatedFetch('/api/export/csv');
    assert.equal(csvExportResponse.status, 200);
    assert.match(csvExportResponse.headers.get('content-type') || '', /^text\/csv/);
    assert.match(csvExportResponse.headers.get('content-disposition') || '', /attachment/);
    assert.equal(csvExportResponse.headers.get('content-length'), null);
    const exportedCSV = await csvExportResponse.text();
    assert.match(exportedCSV, /^Name,Nickname,Email,Phone,Photo URL,Birthday,Birthday Alert \(days before\),How We Met,Tags,Notes/);
    assert.match(exportedCSV, /Release Gate Person/);
    assert.match(exportedCSV, /Imported Production Contact/);

    const simultaneousImports = await Promise.all([
      apiTokenRequest('/api/import/linkedin', 'POST', {
        fullName: 'Concurrent Import',
        email: 'concurrent-import@example.test',
        linkedinUrl: 'https://www.linkedin.com/in/concurrent-import',
      }),
      apiTokenRequest('/api/import/linkedin', 'POST', {
        fullName: 'Concurrent Import',
        email: 'concurrent-import@example.test',
        linkedinUrl: 'https://www.linkedin.com/in/concurrent-import',
      }),
    ]);
    assert.deepEqual(simultaneousImports.map((response) => response.status).sort(), [200, 201]);
    const concurrentImportLookup = await expectJson(
      await authenticatedFetch('/api/contacts?search=concurrent-import%40example.test'),
      200
    );
    assert.equal(concurrentImportLookup.contacts.length, 1);

    const consumedScopedImports = 3;
    const remainingScopedImports = SCOPED_IMPORT_MINUTE_ATTEMPTS - consumedScopedImports;
    const acceptedDuplicateImports = await Promise.all(
      Array.from({ length: remainingScopedImports }, () => apiTokenRequest('/api/import/linkedin', 'POST', {
        fullName: 'Release Gate Person',
        email: 'release-gate@example.test',
      }))
    );
    assert(acceptedDuplicateImports.every((response) => response.status === 200));
    const limitedImportResponse = await apiTokenRequest('/api/import/linkedin', 'POST', {
      fullName: 'Must Not Be Created',
      email: 'rate-limited@example.test',
    });
    const limitedImportRequestId = expectRequestId(limitedImportResponse);
    const limitedImport = await expectJson(limitedImportResponse, 429);
    assert.match(limitedImport.error, /import limit has been reached/i);
    assert.equal(
      limitedImportResponse.headers.get('retry-after'),
      String(limitedImport.retryAfterSeconds)
    );
    const signedInDuplicate = await expectJson(await jsonRequest('/api/import/linkedin', 'POST', {
      fullName: 'Release Gate Person',
      email: 'release-gate@example.test',
    }), 200);
    assert.equal(signedInDuplicate.duplicate, true);
    const limitedContactLookup = await expectJson(
      await authenticatedFetch('/api/contacts?search=rate-limited%40example.test'),
      200
    );
    assert.equal(limitedContactLookup.contacts.length, 0);

    const reminderCompletion = await expectJson(await jsonRequest(
      `/api/reminders/${reminder.reminder.id}`,
      'PATCH',
      { completed: true }
    ), 200);
    assert.equal(reminderCompletion.completionChanged, true);
    const reminderCompletionReplay = await expectJson(await jsonRequest(
      `/api/reminders/${reminder.reminder.id}`,
      'PATCH',
      { completed: true }
    ), 200);
    assert.equal(reminderCompletionReplay.completionChanged, false);
    assert.equal(
      reminderCompletionReplay.reminder.completed_at,
      reminderCompletion.reminder.completed_at
    );

    const planCompletion = await expectJson(await jsonRequest(
      `/api/plans/${plan.plan.id}`,
      'PATCH',
      { completed: true }
    ), 200);
    assert.equal(planCompletion.interactionCreated, true);
    const planCompletionReplay = await expectJson(await jsonRequest(
      `/api/plans/${plan.plan.id}`,
      'PATCH',
      { completed: true }
    ), 200);
    assert.equal(planCompletionReplay.interactionCreated, false);
    assert.equal(planCompletionReplay.plan.completed_at, planCompletion.plan.completed_at);

    for (const [path, label] of [
      [`/api/reminders/${reminder.reminder.id}`, 'reminder'],
      [`/api/plans/${plan.plan.id}`, 'plan'],
      [`/api/interactions/${interaction.interaction.id}`, 'interaction'],
    ]) {
      const deletion = await expectJson(await authenticatedFetch(path, { method: 'DELETE' }), 200);
      assert.equal(deletion.alreadyDeleted, false, label);
      const deletionReplay = await expectJson(await authenticatedFetch(path, { method: 'DELETE' }), 200);
      assert.equal(deletionReplay.alreadyDeleted, true, label);
    }

    const contacts = await expectJson(await authenticatedFetch('/api/contacts'), 200);
    assert.equal(contacts.contacts.length, 3);
    let deletionRecoveryFilename = '';
    for (const contact of contacts.contacts) {
      const deletion = await expectJson(
        await authenticatedFetch(`/api/contacts/${contact.id}`, { method: 'DELETE' }),
        200
      );
      assert.equal(deletion.affected, 1);
      assert.equal(deletion.alreadyDeleted, false);
      assert.match(deletion.recoveryPoint.filename, /^bonds-pre-delete-/);
      deletionRecoveryFilename = deletion.recoveryPoint.filename;
      const deletionReplay = await expectJson(
        await authenticatedFetch(`/api/contacts/${contact.id}`, { method: 'DELETE' }),
        200
      );
      assert.deepEqual(deletionReplay, { success: true, affected: 0, alreadyDeleted: true });
    }
    const statsAfterDelete = await expectJson(await authenticatedFetch('/api/stats'), 200);
    assert.equal(statsAfterDelete.stats.totalContacts, 0);
    const backupsAfterDelete = await expectJson(await authenticatedFetch('/api/settings/backups'), 200);
    assert.equal(backupsAfterDelete.backups.length, 5);
    assert.deepEqual(
      new Set(backupsAfterDelete.backups.map((backup) => backup.reason)),
      new Set(['manual', 'automatic', 'pre-merge', 'pre-delete'])
    );
    assert(backupsAfterDelete.backups.some((backup) => (
      backup.filename === deletionRecoveryFilename && backup.reason === 'pre-delete'
    )));

    const restoreResponse = await jsonRequest('/api/settings/restore', 'POST', {
      filename: manualBackup.backup.filename,
      confirmation: 'RESTORE',
    });
    const restoreRequestId = expectRequestId(restoreResponse);
    const restored = await expectJson(restoreResponse, 200);
    assert.equal(restored.restored, true);
    const statsAfterRestore = await expectJson(await authenticatedFetch('/api/stats'), 200);
    assert.equal(statsAfterRestore.stats.totalContacts, 2);

    const managedRestoredContacts = await expectJson(await authenticatedFetch('/api/contacts'), 200);
    for (const contact of managedRestoredContacts.contacts) {
      await expectJson(await authenticatedFetch(`/api/contacts/${contact.id}`, { method: 'DELETE' }), 200);
    }

    const decryptedPortableBackup = await decryptPortableBackup(
      encryptedPortableBackup,
      portableBackupPassphrase
    );
    const portableRestoreResponse = await authenticatedFetch('/api/settings/restore', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.sqlite3',
        'X-Bonds-Restore-Confirmation': 'RESTORE',
        'X-Bonds-Restore-Filename': 'portable-smoke.db',
      },
      body: decryptedPortableBackup,
    });
    const portableRestoreRequestId = expectRequestId(portableRestoreResponse);
    const portableRestored = await expectJson(portableRestoreResponse, 200);
    assert.equal(portableRestored.restored, true);
    const statsAfterPortableRestore = await expectJson(await authenticatedFetch('/api/stats'), 200);
    assert.equal(statsAfterPortableRestore.stats.totalContacts, 2);

    await expectJson(await jsonRequest('/api/settings/erase', 'POST', {
      confirmation: 'ERASE SOME DATA',
    }), 400);
    const eraseResponse = await jsonRequest('/api/settings/erase', 'POST', {
      confirmation: 'ERASE ALL DATA',
    });
    const eraseRequestId = expectRequestId(eraseResponse);
    const erased = await expectJson(eraseResponse, 200);
    assert.equal(erased.erased, true);
    assert.equal(erased.deletedRows.contacts, 2);
    assert(erased.deletedBackups >= 1);
    assert(erased.deletedBackupArtifacts >= erased.deletedBackups * 2);
    const statsAfterErase = await expectJson(await authenticatedFetch('/api/stats'), 200);
    assert.equal(statsAfterErase.stats.totalContacts, 0);
    const contactsAfterErase = await expectJson(await authenticatedFetch('/api/contacts'), 200);
    assert.deepEqual(contactsAfterErase.contacts, []);
    assert.deepEqual(await readdir(join(temporaryRoot, 'backups')), []);
    const degradedHealth = await expectJson(
      await fetch(`${baseUrl}/api/health/ready`),
      200
    );
    assert.equal(degradedHealth.status, 'degraded');
    assert.equal(degradedHealth.ready, true);
    assert.equal(degradedHealth.checks.backup, 'due');
    assert.deepEqual(await readdir(join(temporaryRoot, 'backups')), []);

    await delay(50);
    const structuredLogs = parseStructuredLogs(output);
    assert(structuredLogs.some((entry) => entry.event === 'runtime.registered'));
    assert(structuredLogs.some((entry) => entry.event === 'backup.automatic_created'));
    assert(structuredLogs.some((entry) => (
      entry.event === 'auth.login_limited' && entry.request_id === lockedOutRequestId
    )));
    assert(structuredLogs.some((entry) => (
      entry.event === 'auth.login_succeeded' && entry.request_id === loginRequestId
    )));
    assert(structuredLogs.some((entry) => (
      entry.event === 'duplicates.merge_succeeded' && entry.request_id === mergeRequestId
    )));
    assert(structuredLogs.some((entry) => (
      entry.event === 'integration.import_limited'
      && entry.request_id === limitedImportRequestId
      && entry.status_code === 429
    )));
    assert(structuredLogs.some((entry) => (
      entry.event === 'backup.manual_created' && entry.request_id === manualBackupRequestId
    )));
    assert(structuredLogs.some((entry) => (
      entry.event === 'database.restore_succeeded' && entry.request_id === restoreRequestId
    )));
    assert(structuredLogs.some((entry) => (
      entry.event === 'database.restore_succeeded'
      && entry.request_id === portableRestoreRequestId
      && entry.operation === 'uploaded_restore'
    )));
    assert(structuredLogs.some((entry) => (
      entry.event === 'workspace.erase_succeeded'
      && entry.request_id === eraseRequestId
      && entry.operation === 'workspace_erase'
    )));
    for (const privateValue of [
      smokePassword,
      smokeSessionSecret,
      smokeApiToken,
      portableBackupPassphrase,
      'Release Gate Person',
      'release-gate@example.test',
      'History from the duplicate profile.',
    ]) {
      assert.equal(output.includes(privateValue), false, privateValue);
    }

    const logoutResponse = await authenticatedFetch('/api/auth/logout', { method: 'POST' });
    const logout = await expectJson(logoutResponse, 200);
    assert.equal(logout.authenticated, false);
    assert.match(logoutResponse.headers.get('set-cookie') || '', /Max-Age=0/i);
    assert.match(logoutResponse.headers.get('set-cookie') || '', /Priority=High/i);
    assert.match(logoutResponse.headers.get('set-cookie') || '', /Secure/i);
    const signedOutSession = await expectJson(await fetch(`${baseUrl}/api/auth/session`), 200);
    assert.equal(signedOutSession.authenticated, false);
  } catch (error) {
    if (output) error.message = `${error.message}\n\nProduction server output:\n${output}`;
    throw error;
  } finally {
    await stopServer(server);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
