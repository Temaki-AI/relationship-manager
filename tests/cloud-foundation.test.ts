import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const schemaSource = readFileSync(new URL('../lib/cloud/schema.ts', import.meta.url), 'utf8');
const wranglerSource = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const authRouteSource = readFileSync(
  new URL('../app/api/auth/[...all]/route.ts', import.meta.url),
  'utf8'
);

test('every cloud CRM data table is explicitly tenant scoped', () => {
  const tenantTables = [
    'contacts',
    'contact_relationships',
    'contact_children',
    'interactions',
    'reminders',
    'reminder_email_preferences',
    'reminder_email_deliveries',
    'birthday_email_deliveries',
    'cloud_backup_schedules',
    'contact_groups',
    'contact_group_members',
    'relationship_facts',
    'integration_connections',
    'sync_jobs',
    'plans',
    'daily_snoozes',
    'contact_export_jobs',
  ];

  for (const tableName of tenantTables) {
    const tableStart = schemaSource.indexOf(`sqliteTable('${tableName}'`);
    assert.notEqual(tableStart, -1, `${tableName} must exist in the cloud schema`);
    const nextTable = schemaSource.indexOf('sqliteTable(', tableStart + 12);
    const tableDefinition = schemaSource.slice(
      tableStart,
      nextTable === -1 ? schemaSource.length : nextTable
    );
    assert.match(tableDefinition, /workspaceId: text\('workspace_id'\)\.notNull\(\)/);
  }
});

test('Cloudflare production bindings and Google auth entrypoint are configured', () => {
  assert.doesNotMatch(wranglerSource, /00000000-0000-0000-0000-000000000000/);
  assert.match(wranglerSource, /"AUTH_MODE": "google"/);
  assert.match(wranglerSource, /"binding": "DB"/);
  assert.match(wranglerSource, /"binding": "PRIVATE_ASSETS"/);
  assert.match(wranglerSource, /"main": "custom-worker\.ts"/);
  assert.match(wranglerSource, /"crons": \["\*\/15 \* \* \* \*"\]/);
  assert.match(authRouteSource, /toNextJsHandler/);
  assert.match(authRouteSource, /getCloudAuth/);
});
