import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createStructuredLogRecord,
  getConfiguredLogLevel,
  getRequestId,
} from '../lib/observability.ts';

test('log configuration accepts explicit levels and defaults safely', () => {
  assert.equal(getConfiguredLogLevel({}), 'info');
  assert.equal(getConfiguredLogLevel({ CRM_LOG_LEVEL: 'WARN' }), 'warn');
  assert.equal(getConfiguredLogLevel({ CRM_LOG_LEVEL: 'silent' }), 'silent');
  assert.equal(getConfiguredLogLevel({ CRM_LOG_LEVEL: 'verbose' }), 'info');
});

test('request correlation accepts generated UUIDs and rejects untrusted values', () => {
  const requestId = '123e4567-e89b-42d3-a456-426614174000';
  assert.equal(getRequestId(new Headers({ 'X-Request-ID': requestId })), requestId);
  assert.equal(getRequestId({ 'x-request-id': requestId.toUpperCase() }), requestId);
  assert.equal(getRequestId({ 'x-request-id': 'attacker\nforged' }), null);
  assert.equal(getRequestId(undefined), null);
});

test('structured records allow operational context but discard private and unsafe fields', () => {
  const record = createStructuredLogRecord(
    'error',
    'contacts.load_failed',
    {
      request_id: '123e4567-e89b-42d3-a456-426614174000',
      method: 'get\n',
      route: '/api/contacts?search=private-name',
      error_name: 'DatabaseError\nforged',
      status_code: 500,
      contact_name: 'Ada Lovelace',
      notes: 'private relationship notes',
    },
    new Date('2026-07-11T12:00:00.000Z')
  );

  assert.deepEqual(record, {
    timestamp: '2026-07-11T12:00:00.000Z',
    level: 'error',
    event: 'contacts.load_failed',
    request_id: '123e4567-e89b-42d3-a456-426614174000',
    method: 'GET',
    route: '/api/contacts',
    error_name: 'DatabaseErrorforged',
    status_code: 500,
  });
  assert.equal(JSON.stringify(record).includes('Ada'), false);
  assert.equal(JSON.stringify(record).includes('private'), false);
});

test('invalid event names cannot inject log structure', () => {
  const record = createStructuredLogRecord('warn', 'bad\n"event', {
    operation: 'restore\nforged',
  });
  assert.equal(record.event, 'application.invalid_event');
  assert.equal(record.operation, 'restoreforged');
});
