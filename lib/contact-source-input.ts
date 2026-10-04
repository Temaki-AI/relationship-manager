import { ContactSourceError, linkedinProfileIdentity, normalizeSourceObservations, readSourceFacts, observeSourceFacts } from '../packages/domain/src/contact-sources.ts';
import { parsePositiveInteger } from './relationship-validation.ts';
import { isSyncUuid } from '../packages/domain/src/sync.ts';

export function sourceCreateInput(body: Record<string, unknown>) {
  const contactId = body.contact_id === null || body.contact_id === undefined ? null : parsePositiveInteger(body.contact_id);
  if (contactId === null && body.contact_id !== null && body.contact_id !== undefined) throw new ContactSourceError('Choose a valid person.');
  const observations = normalizeSourceObservations(body.fields ?? {});
  const epoch = body.expected_epoch === undefined ? null : body.expected_epoch;
  if (epoch !== null && !isSyncUuid(epoch)) throw new ContactSourceError('Refresh the connection form before saving.');
  if (contactId === null && !observations.name) throw new ContactSourceError('A name is required to create a person.');
  return { contact_id: contactId, profile_url: linkedinProfileIdentity(body.profile_url), observations, expected_epoch: epoch };
}
export function sourceExpectedRevision(body: Record<string, unknown>) {
  if (!Number.isSafeInteger(body.expected_revision) || Number(body.expected_revision) < 1) throw new ContactSourceError('Refresh this source before saving.');
  return Number(body.expected_revision);
}
export function sourceChangeFields(current: string, body: Record<string, unknown>) {
  if (body.action === 'use_name') {
    const facts = readSourceFacts(current), name = facts.name?.observed_value;
    if (!name) throw new ContactSourceError('This source has no name to apply.');
    facts.name!.applied_value = name;
    return { fields: JSON.stringify(facts), name };
  }
  if (body.action !== 'observe') throw new ContactSourceError('Choose a valid source action.');
  return { fields: observeSourceFacts(current, normalizeSourceObservations(body.fields)), name: null };
}

export const SOURCE_STALE_MESSAGE = 'This source or person changed. Refresh before saving; your draft is still here.';
