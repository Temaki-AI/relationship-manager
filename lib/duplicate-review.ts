import type { Pagination } from './contact-directory.ts';
import { getDuplicateSignals, type DuplicateContactGroup, type DuplicateIdentity } from './contact-merge.ts';

export const DEFAULT_DUPLICATE_GROUP_PAGE_SIZE = 10;
export const MAX_DUPLICATE_GROUP_PAGE_SIZE = 25;
export const MAX_DUPLICATE_BATCH_CONTACTS = 21;

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

export function paginateDuplicateGroups<T extends DuplicateIdentity>(
  allGroups: DuplicateContactGroup<T>[],
  options: { page?: unknown; pageSize?: unknown } = {},
) {
  const pageSize = boundedInteger(options.pageSize, DEFAULT_DUPLICATE_GROUP_PAGE_SIZE, MAX_DUPLICATE_GROUP_PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(allGroups.length / pageSize));
  const page = Math.min(boundedInteger(options.page, 1, Number.MAX_SAFE_INTEGER), totalPages);
  const pagination: Pagination = { page, pageSize, total: allGroups.length, totalPages };
  const pageGroups = allGroups.slice((page - 1) * pageSize, page * pageSize);
  return {
    pageGroups,
    groupCount: allGroups.length,
    contactCount: allGroups.reduce((total, group) => total + group.contacts.length, 0),
    truncatedGroupCount: allGroups.filter((group) => group.contacts.length > MAX_DUPLICATE_BATCH_CONTACTS).length,
    pagination,
  };
}

export function selectDuplicateBatch<T extends DuplicateIdentity>(group: DuplicateContactGroup<T>): number[] {
  if (group.contacts.length <= MAX_DUPLICATE_BATCH_CONTACTS) return group.contacts.map((contact) => contact.id);
  const byId = new Map(group.contacts.map((contact) => [contact.id, contact]));
  const root = byId.has(group.recommendedPrimaryId) ? group.recommendedPrimaryId : group.contacts[0].id;
  const signals = new Map<number, string[]>();
  const members = new Map<string, number[]>();
  for (const contact of group.contacts) {
    const keys = getDuplicateSignals(contact).map((signal) => signal.key);
    signals.set(contact.id, keys);
    for (const key of keys) {
      const ids = members.get(key) || [];
      ids.push(contact.id);
      members.set(key, ids);
    }
  }
  const selected = new Set([root]);
  const queue = [root];
  const exploredSignals = new Set<string>();
  for (let index = 0; index < queue.length && selected.size < MAX_DUPLICATE_BATCH_CONTACTS; index += 1) {
    for (const key of signals.get(queue[index]) || []) {
      if (exploredSignals.has(key)) continue;
      exploredSignals.add(key);
      for (const id of members.get(key) || []) {
        if (selected.has(id)) continue;
        selected.add(id);
        queue.push(id);
        if (selected.size === MAX_DUPLICATE_BATCH_CONTACTS) break;
      }
      if (selected.size === MAX_DUPLICATE_BATCH_CONTACTS) break;
    }
  }
  return group.contacts.filter((contact) => selected.has(contact.id)).map((contact) => contact.id);
}
