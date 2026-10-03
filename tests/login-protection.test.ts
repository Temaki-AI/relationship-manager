import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ACCOUNT_LOGIN_ATTEMPTS,
  ACCOUNT_LOGIN_WINDOW_MILLISECONDS,
  CLIENT_LOGIN_ATTEMPTS,
  CLIENT_LOGIN_WINDOW_MILLISECONDS,
  clearLoginAttempts,
  consumeLoginAttempt,
  countStoredLoginLimitKeys,
  getLoginClientKey,
} from '../lib/login-protection.ts';
import { trustsProxyHeaders } from '../lib/request-security.ts';

function createDatabase(filename = ':memory:') {
  const db = new Database(filename);
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  return db;
}

test('proxy headers are ignored by default and validated when explicitly trusted', () => {
  const headers = new Headers({
    'cf-connecting-ip': '203.0.113.10',
    'x-real-ip': '198.51.100.8',
    'x-forwarded-for': '192.0.2.5, 192.0.2.6',
  });
  assert.equal(trustsProxyHeaders({}), false);
  assert.equal(trustsProxyHeaders({ CRM_TRUST_PROXY_HEADERS: 'true' }), true);
  assert.equal(getLoginClientKey(headers, false), 'direct-client');
  assert.equal(getLoginClientKey(headers, true), 'ip:203.0.113.10');

  const spoofed = new Headers({
    'cf-connecting-ip': 'not-an-ip',
    'x-real-ip': 'also-invalid',
    'x-forwarded-for': 'attacker-controlled-value',
  });
  assert.equal(getLoginClientKey(spoofed, true), 'trusted-proxy-unknown-client');
});

test('client lockout is atomic, expires, and stores no raw client identity', () => {
  const db = createDatabase();
  try {
    const now = Date.UTC(2026, 6, 11, 8, 0, 0);
    for (let attempt = 0; attempt < CLIENT_LOGIN_ATTEMPTS; attempt += 1) {
      assert.equal(consumeLoginAttempt(db, 'ip:203.0.113.44', now).allowed, true);
    }
    const blocked = consumeLoginAttempt(db, 'ip:203.0.113.44', now);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterSeconds, CLIENT_LOGIN_WINDOW_MILLISECONDS / 1000);
    assert.equal(countStoredLoginLimitKeys(db), 2);

    const serializedRows = JSON.stringify(db.prepare('SELECT key, value FROM app_metadata').all());
    assert.doesNotMatch(serializedRows, /203\.0\.113\.44/);

    const afterExpiry = consumeLoginAttempt(
      db,
      'ip:203.0.113.44',
      now + CLIENT_LOGIN_WINDOW_MILLISECONDS + 1
    );
    assert.equal(afterExpiry.allowed, true);
    assert.equal(countStoredLoginLimitKeys(db), 2);
  } finally {
    db.close();
  }
});

test('account-wide limiter bounds rotating clients with a short recovery window', () => {
  const db = createDatabase();
  try {
    const now = Date.UTC(2026, 6, 11, 8, 0, 0);
    for (let attempt = 0; attempt < ACCOUNT_LOGIN_ATTEMPTS; attempt += 1) {
      assert.equal(consumeLoginAttempt(db, `ip:198.51.100.${attempt + 1}`, now).allowed, true);
    }
    const blocked = consumeLoginAttempt(db, 'ip:198.51.100.250', now);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterSeconds, ACCOUNT_LOGIN_WINDOW_MILLISECONDS / 1000);
    assert.equal(countStoredLoginLimitKeys(db), ACCOUNT_LOGIN_ATTEMPTS + 1);

    const recovered = consumeLoginAttempt(
      db,
      'ip:198.51.100.250',
      now + ACCOUNT_LOGIN_WINDOW_MILLISECONDS + 1
    );
    assert.equal(recovered.allowed, true);
    assert.ok(clearLoginAttempts(db) > 0);
    assert.equal(countStoredLoginLimitKeys(db), 0);
  } finally {
    db.close();
  }
});

test('login lockouts persist across database connections', () => {
  const root = mkdtempSync(join(tmpdir(), 'bonds-login-protection-'));
  const filename = join(root, 'auth.db');
  const now = Date.UTC(2026, 6, 11, 8, 0, 0);
  let db = createDatabase(filename);
  try {
    for (let attempt = 0; attempt < CLIENT_LOGIN_ATTEMPTS; attempt += 1) {
      consumeLoginAttempt(db, 'direct-client', now);
    }
    db.close();
    db = createDatabase(filename);
    assert.equal(consumeLoginAttempt(db, 'direct-client', now).allowed, false);
  } finally {
    if (db.open) db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
