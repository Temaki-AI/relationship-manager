import { isSyncUuid } from './sync.ts';

export const MAX_CONTACT_MERGE_ALIASES = 10_000;
/** Alias identity is authoritative CRM data; normalization never creates identities. */
export function readContactMergeAliases(value: unknown, canonicalId?: string): string[] {
  if (value === undefined) return []; // Older contact projections and snapshot versions.
  if (typeof value !== 'string' || value.length > 400_001) throw new Error('Invalid merged contact identities.');
  let aliases: unknown;
  try { aliases = JSON.parse(value); } catch { throw new Error('Invalid merged contact identities.'); }
  if (!Array.isArray(aliases) || aliases.length > MAX_CONTACT_MERGE_ALIASES || aliases.some((id) => !isSyncUuid(id) || id === canonicalId)
    || new Set(aliases).size !== aliases.length) throw new Error('Invalid merged contact identities.');
  return aliases as string[];
}
