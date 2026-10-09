import type { SQLiteDatabase } from 'expo-sqlite';

const listeners = new WeakMap<SQLiteDatabase, Set<() => void>>();
export function subscribeSyncChanges(db: SQLiteDatabase, listener: () => void) {
  const subscribers = listeners.get(db) ?? new Set<() => void>();
  subscribers.add(listener); listeners.set(db, subscribers);
  return () => { subscribers.delete(listener); };
}
export function signalSyncChange(db: SQLiteDatabase) {
  for (const listener of listeners.get(db) ?? []) listener();
}
