import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { isSyncUuid } from '../../../../packages/domain/src/sync';
const KEY = 'everclose.contact-installation';
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
let pending: Promise<string> | null = null;
export function deviceContactInstallation(): Promise<string> {
  if (pending) return pending;
  const task = (async () => {
    const existing = await SecureStore.getItemAsync(KEY, options);
    if (existing !== null) { if (!isSyncUuid(existing)) throw new Error('Unable to read this phone’s Contacts identity.'); return existing; }
    const id = Crypto.randomUUID(); await SecureStore.setItemAsync(KEY, id, options); return id;
  })();
  pending = task; void task.finally(() => { if (pending === task) pending = null; }).catch(() => {}); return task;
}
