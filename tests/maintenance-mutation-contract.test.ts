import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const MUTATION_ROUTES = [
  'app/api/contacts/route.ts',
  'app/api/contacts/[id]/route.ts',
  'app/api/contacts/bulk/route.ts',
  'app/api/groups/route.ts',
  'app/api/groups/[id]/route.ts',
  'app/api/groups/[id]/members/route.ts',
  'app/api/groups/tags/contacts/route.ts',
  'app/api/import/csv/route.ts',
  'app/api/import/linkedin/route.ts',
  'app/api/import/vcard/route.ts',
  'app/api/interactions/route.ts',
  'app/api/interactions/[id]/route.ts',
  'app/api/plans/route.ts',
  'app/api/plans/[id]/route.ts',
  'app/api/reminders/route.ts',
  'app/api/reminders/[id]/route.ts',
];

const METADATA_MUTATION_ROUTES = [
  'app/api/auth/login/route.ts',
];

test('user-data mutation routes participate in maintenance isolation', () => {
  for (const filename of MUTATION_ROUTES) {
    const source = readFileSync(filename, 'utf8');
    assert.match(
      source,
      /withDatabaseMutationLock|deleteContactsWithRecovery/,
      filename
    );
    assert.match(source, /DatabaseMaintenanceBusyError/, filename);
  }
});

test('authentication metadata writes participate in maintenance isolation', () => {
  for (const filename of METADATA_MUTATION_ROUTES) {
    assert.match(readFileSync(filename, 'utf8'), /withDatabaseMutationLock/, filename);
  }
});
