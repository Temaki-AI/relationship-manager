import type { SQLiteDatabase } from 'expo-sqlite';
import { commitDeviceRead, nextDeviceReads } from '@/data/device-contact-reconciliation';
import { readLinkedDeviceContact } from './device-contacts';
const running = new WeakMap<SQLiteDatabase, Promise<{ checked: number; changed: number }>>();
export function runDeviceContactReads(db: SQLiteDatabase, options: { isCurrent?: () => boolean; forceSource?: string } = {}): Promise<{ checked: number; changed: number }> {
  const existing = running.get(db); if (existing) return options.forceSource ? existing.then(() => runDeviceContactReads(db, options)) : existing;
  const isCurrent = options.isCurrent ?? (() => true);
  const task = (async () => {
    let checked = 0, changed = 0;
    for (const intent of await nextDeviceReads(db, options.forceSource)) {
      if (!isCurrent()) break;
      try {
        const result = await readLinkedDeviceContact(intent.source.device_contact_id); checked++;
        if (await commitDeviceRead(db, intent, result, isCurrent)) changed++;
      } catch {
        if (await commitDeviceRead(db, intent, { state: 'error', reason: 'read_or_capacity_error' }, isCurrent)) changed++;
      }
    }
    return { checked, changed };
  })();
  running.set(db, task); void task.finally(() => { if (running.get(db) === task) running.delete(db); }).catch(() => {}); return task;
}
