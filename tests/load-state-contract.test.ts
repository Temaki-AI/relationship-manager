import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createResponseError, ResponseError } from '../lib/utils.ts';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

function readSource(path: string): string {
  return readFileSync(join(projectRoot, path), 'utf8');
}

test('response errors retain their HTTP status and safe API message', async () => {
  const error = await createResponseError(
    new Response(JSON.stringify({ error: 'Contact not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    }),
    'Failed to fetch contact'
  );

  assert(error instanceof ResponseError);
  assert.equal(error.status, 404);
  assert.equal(error.message, 'Contact not found');
});

test('the shared load failure state is accessible and retryable', () => {
  const source = readSource('components/ui/load-error.tsx');
  assert.match(source, /role="alert"/);
  assert.match(source, /aria-labelledby=/);
  assert.match(source, /onClick=\{onRetry\}/);
  assert.match(source, /Trying again\.\.\./);
  assert.match(source, /disabled=\{retrying\}/);
});

test('contact detail and edit distinguish missing records from load failures', () => {
  for (const path of ['app/contacts/[id]/page.tsx', 'app/contacts/[id]/edit/page.tsx']) {
    const source = readSource(path);
    assert.match(source, /throw await createResponseError/);
    assert.match(source, /loadFailure\?\.status === 404/);
    assert.match(source, /<LoadError/);
    assert.match(source, /setReloadToken/);
  }

  const editor = readSource('app/contacts/[id]/edit/page.tsx');
  assert(editor.indexOf('if (loadFailure)') < editor.indexOf('<form onSubmit={handleSubmit}>'));
  assert.match(editor, /No blank form has been opened/);
});

test('primary directories keep request failures separate from empty results', () => {
  for (const path of [
    'app/contacts/page.tsx',
    'app/groups/page.tsx',
    'app/smart-lists/page.tsx',
  ]) {
    const source = readSource(path);
    assert.match(source, /if \(![A-Za-z]+\.ok\)/, path);
    assert.match(source, /const \[loadError, setLoadError\]/, path);
    assert.match(source, /<LoadError/, path);
    assert.match(source, /setLoadError\(null\)/, path);
    assert.match(source, /setReloadToken/, path);
  }
});

test('recovery controls stay hidden until backup state is verified', () => {
  const settings = readSource('app/settings/page.tsx');
  const failureGuard = settings.indexOf('if (loadError || !data)');
  const recoveryControls = settings.indexOf('<ConfirmDialog');

  assert(failureGuard > 0);
  assert(recoveryControls > failureGuard);
  assert.match(settings, /Backup and restore controls are hidden until verification succeeds/);
  assert.match(settings, /retrying=\{loading\}/);
  assert.match(settings, /setReloadToken/);
});

test('failed uploaded restores return to an editable retry state', () => {
  const settings = readSource('app/settings/page.tsx');
  const uploadedRestore = settings.slice(
    settings.indexOf('async function restoreUploadedBackup()'),
    settings.indexOf('async function eraseAllData()')
  );

  assert.equal((uploadedRestore.match(/setConfirmationTarget\(null\)/g) || []).length, 2);
  assert.equal((uploadedRestore.match(/setRestoreFile\(null\)/g) || []).length, 1);
  assert.equal((uploadedRestore.match(/setRestorePassphrase\(''\)/g) || []).length, 1);
  assert.match(settings, /'Decrypting and validating\.\.\.'/);
});

test('nested group failures cannot masquerade as empty membership', () => {
  const groups = readSource('app/groups/page.tsx');

  assert(groups.indexOf('membersError ?') < groups.indexOf('No contacts in this group.'));
  assert(groups.indexOf('availableError ?') < groups.indexOf('All contacts already belong to this group.'));
  assert.match(groups, /No empty membership claim is being shown/);
  assert.match(groups, /No availability claim is being shown/);
});

test('a committed group addition is not reported as failed when refresh is unavailable', () => {
  const groups = readSource('app/groups/page.tsx');
  const handler = groups.slice(
    groups.indexOf('async function addSelectedContacts()'),
    groups.indexOf('if (loading && !loadError)')
  );

  assert.doesNotMatch(handler, /await fetchDirectory/);
  assert.doesNotMatch(handler, /await fetchGroups/);
  assert.match(handler, /setGroups\(\(previous\) =>/);
  assert.match(handler, /toast\(\{ message: `Added/);
});

test('committed relationship changes are separated from contact refresh failures', () => {
  const detail = readSource('app/contacts/[id]/page.tsx');
  const refreshBoundary = detail.slice(
    detail.indexOf('async function refreshAfterCommittedMutation'),
    detail.indexOf('async function loadMoreHistory')
  );
  const mutationHandlers = detail.slice(
    detail.indexOf('async function handleLogInteraction'),
    detail.indexOf('if (loading && !loadFailure)')
  );

  assert(refreshBoundary.indexOf('toast({ message: successMessage })') < refreshBoundary.indexOf('await refreshContact()'));
  assert.match(refreshBoundary, /changeCommitted: true/);
  assert.equal((mutationHandlers.match(/await refreshAfterCommittedMutation\(/g) || []).length, 7);
  assert.doesNotMatch(mutationHandlers, /await refreshContact\(\)/);
  assert.match(detail, /Your change was saved, but this page could not refresh safely/);
});

test('committed directory changes report success before attempting refresh', () => {
  const contacts = readSource('app/contacts/page.tsx');
  const importHandler = contacts.slice(
    contacts.indexOf('async function handleContactImport'),
    contacts.indexOf('async function handleBulkAction')
  );
  const bulkHandler = contacts.slice(
    contacts.indexOf('async function handleBulkAction'),
    contacts.indexOf('if (loading && !loadError)')
  );

  assert(importHandler.indexOf('message: detail') < importHandler.indexOf('await refreshData(1)'));
  assert(bulkHandler.indexOf('toast({ message: successMessage })') < bulkHandler.indexOf('await refreshData()'));
  assert.match(importHandler, /Import completed \(\$\{detail\}\), but the contact directory could not be refreshed/);
  assert.match(bulkHandler, /The change was saved, but the contact directory could not be refreshed/);
  assert.doesNotMatch(importHandler, /Promise\.all\(\[refreshData/);
  assert.doesNotMatch(bulkHandler, /Promise\.all\(\[refreshData/);
});
