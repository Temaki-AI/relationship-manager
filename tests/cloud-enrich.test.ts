import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudHarness } from './helpers/cloud-harness.ts';

test('cloud contact creation can fill company context from an email domain', async () => {
  const h = await createCloudHarness();
  try {
    const business = await h.call('enrich', { method: 'POST', body: { email: 'ada@analytical-engines.com' } });
    assert.equal(business.status, 200);
    assert.deepEqual(business.body, {
      success: true,
      found: true,
      data: {
        company: 'Analytical Engines',
        companyDomain: 'analytical-engines.com',
        source: 'email-domain',
        suggestedNotes: 'Company: Analytical Engines',
      },
    });
    const personal = await h.call('enrich', { method: 'POST', body: { email: 'ada@gmail.com' } });
    assert.deepEqual(personal.body, { success: true, found: false, data: {} });
    assert.equal((await h.call('enrich', { method: 'POST', body: { email: 'not-an-email' } })).status, 400);
    assert.equal((await h.call('enrich', { method: 'POST', body: null })).status, 400);
  } finally { await h.close(); }
});
