import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('contact portability validates real files and describes its deployment boundary accurately', () => {
  const csvImport = readFileSync('app/api/import/csv/route.ts', 'utf8');
  const vcardImport = readFileSync('app/api/import/vcard/route.ts', 'utf8');
  const csvExport = readFileSync('app/api/export/csv/route.ts', 'utf8');
  const contacts = readFileSync('app/contacts/page.tsx', 'utf8');

  for (const route of [csvImport, vcardImport]) {
    assert.match(route, /if \(!\(file instanceof File\)\)/);
  }
  assert.match(csvExport, /filename=\"everclose-contacts-\$\{/);
  assert.match(contacts, /Files go only to this Everclose CRM installation/);
  assert.doesNotMatch(contacts, /processed on this device/i);
});
