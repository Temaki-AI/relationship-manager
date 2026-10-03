import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const CREATE_ROUTES = [
  'app/api/contacts/route.ts',
  'app/api/interactions/route.ts',
  'app/api/reminders/route.ts',
  'app/api/plans/route.ts',
];

test('consumer create routes require and atomically persist replay protection', () => {
  for (const filename of CREATE_ROUTES) {
    const source = readFileSync(filename, 'utf8');
    assert.match(source, /requireIdempotencyKey\(request\.headers\)/, filename);
    assert.match(source, /runIdempotentCreate\(db, \{/, filename);
    assert.match(source, /fingerprintIdempotencyInput\(/, filename);
    assert.match(source, /withDatabaseMutationLock/, filename);
    assert.match(source, /'Idempotency-Replayed': String\(result\.replayed\)/, filename);
    assert.match(source, /error instanceof IdempotencyError/, filename);
  }
});

test('consumer forms retain one request for ambiguous retries and clear it after success', () => {
  const newContact = readFileSync('app/contacts/new/page.tsx', 'utf8');
  assert.match(newContact, /createAttempt\.current \|\| \{ payload, key: createIdempotencyKey\(\) \}/);
  assert.match(newContact, /'Idempotency-Key': attempt\.key/);
  assert.match(newContact, /body: attempt\.payload/);
  assert.match(newContact, /if \(res\.status !== 409\) createAttempt\.current = null/);
  assert.match(newContact, /function discardDraft\(\) \{\s+createAttempt\.current = null/);
  assert.match(newContact, /discardDraft\(\);\s+if \(reconcilingEarlierSave\)/);
  assert.match(newContact, /same request will be reused safely/);

  const detail = readFileSync('app/contacts/[id]/page.tsx', 'utf8');
  assert.equal((detail.match(/'Idempotency-Key': idempotencyKey/g) || []).length, 5);
  assert.equal((detail.match(/\.current \|\| createIdempotencyKey\(\)/g) || []).length, 5);
  assert.equal((detail.match(/same request will be reused safely/g) || []).length, 5);
});

test('configured cross-origin clients may send and inspect replay headers', () => {
  const middleware = readFileSync('middleware.ts', 'utf8');
  assert.match(middleware, /Access-Control-Allow-Headers[^\n]+Idempotency-Key/);
  assert.match(middleware, /Access-Control-Expose-Headers[^\n]+Idempotency-Replayed/);
});
