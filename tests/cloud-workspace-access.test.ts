import assert from 'node:assert/strict';
import test from 'node:test';
import { cloudWorkspaceMaintenanceResponse } from '../lib/cloud/workspace-access.ts';

test('normal cloud API actions are blocked during maintenance without hiding recovery status', async () => {
  const paths = [
    ['contacts'], ['contacts', '1'], ['calendar'], ['reminders'], ['settings', 'restore'],
    ['settings', 'backups', 'file.json'], ['import', 'jobs'], ['export', 'jobs'],
  ];
  for (const lifecycle of ['erasing', 'restoring']) {
    for (const path of paths) {
      const response = cloudWorkspaceMaintenanceResponse(lifecycle, path, path[0] === 'contacts' ? 'DELETE' : 'GET');
      assert.equal(response?.status, 423, `${lifecycle} ${path.join('/')}`);
      assert.equal(response?.headers.get('Cache-Control'), 'no-store');
      assert.equal((await response!.json()).lifecycle, lifecycle);
    }
    assert.equal(cloudWorkspaceMaintenanceResponse(lifecycle, ['settings', 'backups'], 'GET'), null);
    assert.equal(cloudWorkspaceMaintenanceResponse(lifecycle, ['settings', 'backups'], 'POST')?.status, 423);
  }
  assert.equal(cloudWorkspaceMaintenanceResponse('erasing', ['settings', 'erase'], 'POST'), null);
  assert.equal(cloudWorkspaceMaintenanceResponse('erasing', ['settings', 'erase'], 'GET')?.status, 423);
  assert.equal(cloudWorkspaceMaintenanceResponse('restoring', ['settings', 'erase'], 'POST')?.status, 423);
  assert.equal(cloudWorkspaceMaintenanceResponse('restoring', ['settings', 'large-recovery'], 'GET'), null);
  assert.equal(cloudWorkspaceMaintenanceResponse('restoring', ['settings', 'large-recovery', 'job', 'step'], 'POST'), null);
  assert.equal(cloudWorkspaceMaintenanceResponse('restoring', ['settings', 'large-recovery', 'job'], 'DELETE')?.status, 423);
  assert.equal(cloudWorkspaceMaintenanceResponse('erasing', ['settings', 'large-recovery'], 'GET')?.status, 423);
  assert.equal(cloudWorkspaceMaintenanceResponse('unknown', ['settings', 'backups'], 'GET')?.status, 423);
  assert.equal(cloudWorkspaceMaintenanceResponse('active', ['contacts'], 'DELETE'), null);
});
