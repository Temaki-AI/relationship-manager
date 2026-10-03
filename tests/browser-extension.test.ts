import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DEFAULT_API_BASE_URL,
  normalizeApiBaseUrl,
} from '../browser-extension/settings.js';

test('extension CRM URLs are origin-only and require secure remote transport', () => {
  assert.equal(normalizeApiBaseUrl(''), DEFAULT_API_BASE_URL);
  assert.equal(normalizeApiBaseUrl('http://localhost:3100/'), 'http://localhost:3100');
  assert.equal(normalizeApiBaseUrl('http://127.0.0.1:3100'), 'http://127.0.0.1:3100');
  assert.equal(normalizeApiBaseUrl('http://[::1]:3100'), 'http://[::1]:3100');
  assert.equal(normalizeApiBaseUrl('https://crm.example.test'), 'https://crm.example.test');

  for (const value of [
    'crm.example.test',
    'ftp://crm.example.test',
    'https://user:secret@crm.example.test',
    'https://crm.example.test/bonds',
    'https://crm.example.test?next=attacker',
    'https://crm.example.test#token',
    'http://crm.example.test',
    'http://192.168.1.20:3100',
  ]) {
    assert.throws(() => normalizeApiBaseUrl(value), undefined, value);
  }
});

test('extension configuration is local-only and removes the legacy synchronized URL', () => {
  const popupSource = readFileSync('browser-extension/popup.js', 'utf8');
  const popupHtml = readFileSync('browser-extension/popup.html', 'utf8');
  assert.doesNotMatch(popupSource, /chrome\.storage\.sync\.set/);
  assert.match(popupSource, /chrome\.storage\.sync\.remove\(['"]apiBaseUrl['"]\)/);
  assert.match(popupSource, /chrome\.storage\.local\.get/);
  assert.match(popupSource, /chrome\.storage\.local\.set/);
  assert.match(popupHtml, /never synced/i);
  const manifest = JSON.parse(readFileSync('browser-extension/manifest.json', 'utf8')) as {
    version: string;
  };
  assert.equal(manifest.version, '0.2.0');
});
