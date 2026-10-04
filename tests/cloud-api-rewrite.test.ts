import assert from 'node:assert/strict';
import test from 'node:test';
import { getCloudApiRewrite } from '../lib/cloud/api-rewrite.ts';

test('cloud export job routes rewrite to their authenticated handlers', () => {
  const id = '7a9d9fbc-e4c0-4597-ae15-2df10dfb4955';
  assert.equal(getCloudApiRewrite('/api/export/jobs'), '/api/cloud/export/jobs');
  assert.equal(getCloudApiRewrite('/api/today/snooze'), '/api/cloud/today/snooze');
  assert.equal(getCloudApiRewrite('/api/reminders/email-preferences'), '/api/cloud/reminders/email-preferences');
  assert.equal(getCloudApiRewrite('/api/settings/large-recovery'), '/api/cloud/settings/large-recovery');
  assert.equal(getCloudApiRewrite('/api/enrich'), '/api/cloud/enrich');
  assert.equal(getCloudApiRewrite(`/api/settings/large-recovery/${id}/rollback`), `/api/cloud/settings/large-recovery/${id}/rollback`);
  assert.equal(getCloudApiRewrite(`/api/settings/large-recovery/${id}/pause`), `/api/cloud/settings/large-recovery/${id}/pause`);
  assert.equal(getCloudApiRewrite(`/api/settings/large-recovery/${id}/resume`), `/api/cloud/settings/large-recovery/${id}/resume`);
  assert.equal(getCloudApiRewrite('/api/settings/large-recovery/not-a-job/step'), null);
  assert.equal(getCloudApiRewrite(`/api/settings/large-recovery/${id}/retry`), null);
  assert.equal(getCloudApiRewrite('/api/contacts/42/photo'), '/api/cloud/contacts/42/photo');
  assert.equal(getCloudApiRewrite('/api/contacts/not-an-id/photo'), null);
  assert.equal(getCloudApiRewrite(`/api/export/jobs/${id}`), `/api/cloud/export/jobs/${id}`);
  assert.equal(getCloudApiRewrite(`/api/export/jobs/${id}/download`), `/api/cloud/export/jobs/${id}/download`);
  assert.equal(getCloudApiRewrite('/api/export/jobs/not-a-job/download'), null);
  assert.equal(getCloudApiRewrite(`/api/export/jobs/${id}/unexpected`), null);
});

test('cloud-visible People, Today, Calendar, and Settings actions have a rewrite', () => {
  const id = '7a9d9fbc-e4c0-4597-ae15-2df10dfb4955';
  const visiblePaths = [
    '/api/contacts', '/api/contacts/bulk', '/api/contacts/duplicates', '/api/contacts/42', '/api/contacts/42/photo',
    '/api/contacts/42/children', '/api/contacts/42/children/7',
    '/api/contacts/42/relationships', '/api/contacts/42/relationships/7',
    '/api/sources/context', '/api/sources/linkedin', '/api/contacts/42/sources', `/api/contacts/42/sources/${id}`,
    '/api/sources/linkedin/import', '/api/sources/linkedin/import/preview',
    '/api/contacts/42/device-sources', '/api/v1/device-sources/push',
    '/api/enrich', '/api/groups/tags', '/api/groups/tags/contacts',
    '/api/import/csv', '/api/import/vcard', '/api/import/jobs', `/api/import/jobs/${id}`,
    `/api/import/jobs/${id}/source`, '/api/export/jobs', `/api/export/jobs/${id}`,
    `/api/export/jobs/${id}/download`, '/api/interactions', '/api/interactions/42',
    '/api/reminders', '/api/reminders/42', '/api/reminders/email-preferences',
    '/api/plans', '/api/plans/42', '/api/calendar', '/api/today/snooze',
    '/api/intelligence/overview', '/api/smart-lists', '/api/stats',
    '/api/settings/backups', '/api/settings/restore', '/api/settings/erase',
    '/api/settings/large-recovery', `/api/settings/large-recovery/${id}`,
    ...['step', 'apply', 'rollback', 'pause', 'resume', 'cancel'].map((action) =>
      `/api/settings/large-recovery/${id}/${action}`),
  ];
  for (const path of visiblePaths) {
    assert.ok(getCloudApiRewrite(path), `${path} must reach a cloud handler`);
  }
});

test('only supported sync protocol routes reach authenticated cloud handlers', () => {
  for (const action of ['bootstrap', 'pull', 'push']) {
    assert.equal(getCloudApiRewrite(`/api/v1/sync/${action}`), `/api/cloud/v1/sync/${action}`);
    assert.equal(getCloudApiRewrite(`/api/v2/sync/${action}`), `/api/cloud/v2/sync/${action}`);
    assert.equal(getCloudApiRewrite(`/api/v3/sync/${action}`), `/api/cloud/v3/sync/${action}`);
    assert.equal(getCloudApiRewrite(`/api/v4/sync/${action}`), `/api/cloud/v4/sync/${action}`);
  }
  assert.equal(getCloudApiRewrite('/api/v5/sync/push'), null);
  assert.equal(getCloudApiRewrite('/api/v4/sync/unknown'), null);
  assert.equal(getCloudApiRewrite('/api/v3/sync/unknown'), null);
  assert.equal(getCloudApiRewrite('/api/v2/sync/unknown'), null);
  assert.equal(getCloudApiRewrite('/api/v1/sync/unknown'), null);
});

test('phone approval, device management and scoped session routes have exact cloud rewrites', () => {
  for (const path of ['/api/v1/devices', '/api/v1/devices/authorize', '/api/v1/devices/session',
    '/api/v1/devices/7a9d9fbc-e4c0-4597-ae15-2df10dfb4955']) {
    assert.equal(getCloudApiRewrite(path), path.replace('/api/', '/api/cloud/'));
  }
  assert.equal(getCloudApiRewrite('/api/v1/devices/not-a-device'), null);
  assert.equal(getCloudApiRewrite('/api/v1/devices/session/unexpected'), null);
  assert.equal(getCloudApiRewrite('/api/auth/device/exchange'), null);
});
