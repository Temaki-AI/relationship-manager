import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { CLOUD_READINESS_MIGRATION, getCloudReadinessReport } from '../lib/cloud/health.ts';

const environment = {
  BETTER_AUTH_URL: 'https://everclosecrm.com',
  BETTER_AUTH_SECRET: 'readiness-test-secret',
  GOOGLE_CLIENT_ID: 'readiness-test-client',
  GOOGLE_CLIENT_SECRET: 'readiness-test-client-secret',
  CLOUD_AUTOMATIC_BACKUP_ENABLED: 'false',
};

test('cloud readiness checks D1 migrations and Google configuration without local SQLite', async () => {
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("test"); } }',
    d1Databases: ['DB'],
  }));
  try {
    const db = await runtime.getD1Database('DB');
    await db.prepare('CREATE TABLE d1_migrations (name TEXT NOT NULL)').run();
    const outdated = await getCloudReadinessReport(db, environment);
    assert.equal(outdated.ready, false);
    assert.equal(outdated.checks.schema, 'incompatible');

    await db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind('0023_married_zaran.sql').run();
    await db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind('0024_contact_sync_foundation.sql').run();
    assert.equal((await getCloudReadinessReport(db, environment)).ready, false, 'the device migration is required');

    await db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(CLOUD_READINESS_MIGRATION).run();
    const current = await getCloudReadinessReport(db, environment);
    assert.equal(current.ready, true);
    assert.equal(current.checks.authentication, 'google');
    assert.equal(current.checks.backup, 'disabled');

    const misconfigured = await getCloudReadinessReport(db, { ...environment, GOOGLE_CLIENT_SECRET: '' });
    assert.equal(misconfigured.ready, false);
    assert.equal(misconfigured.checks.authentication, 'misconfigured');
  } finally {
    await runtime.dispose();
  }
});

test('cloud readiness rejects a missing migration table instead of reporting a healthy database', async () => {
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("test"); } }',
    d1Databases: ['DB'],
  }));
  try {
    const db = await runtime.getD1Database('DB');
    await assert.rejects(getCloudReadinessReport(db, environment), /no such table/);
  } finally {
    await runtime.dispose();
  }
});
