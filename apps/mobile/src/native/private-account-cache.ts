const cleaners = new Map<string, Set<() => Promise<void>>>();
export function registerPrivateAccountCache(scope: string, clear: () => Promise<void>) {
  const entries = cleaners.get(scope) ?? new Set(); entries.add(clear); cleaners.set(scope, entries);
  return () => { entries.delete(clear); if (!entries.size) cleaners.delete(scope); };
}
export async function clearPrivateAccountCaches(scope: string) {
  for (const clear of cleaners.get(scope) ?? []) await clear();
}
