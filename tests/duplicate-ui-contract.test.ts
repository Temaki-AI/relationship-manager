import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('duplicate cleanup exposes named primary choices and unique profile actions', () => {
  const source = readFileSync('app/contacts/duplicates/page.tsx', 'utf8');

  assert.match(source, /<fieldset>/);
  assert.match(source, /<legend className="sr-only">/);
  assert.match(source, /name=\{groupName\}/);
  assert.match(source, /aria-label=\{`Keep \$\{contact\.name\} as the primary profile`\}/);
  assert.match(source, /aria-label=\{`Inspect \$\{contact\.name\}`\}/);
  assert.match(source, /role="region"/);
  assert.match(source, /aria-labelledby=\{`duplicate-group-\$\{group\.id\}`\}/);
});

test('cloud duplicate cleanup scans all people before offering a recovery-backed merge', () => {
  const page = readFileSync('app/contacts/duplicates/page.tsx', 'utf8');
  const directory = readFileSync('app/contacts/page.tsx', 'utf8');
  assert.match(page, /while \(cursor !== null\)/);
  assert.match(page, /Checking \{scanProgress\.scanned\.toLocaleString\(\)\}/);
  assert.match(page, /Merge succeeded, but review could not refresh/);
  assert.match(directory, /href="\/contacts\/duplicates"/);
});

test('an uncertain cloud merge keeps the same request key and distinguishes replay from a new merge', () => {
  const page = readFileSync('app/contacts/duplicates/page.tsx', 'utf8');
  assert.match(page, /mergeAttemptRef\.current\?\.signature === signature/);
  assert.match(page, /'Idempotency-Key': requestKey/);
  assert.match(page, /result\.replayed/);
  assert.match(page, /Retry this same merge safely/);
});
