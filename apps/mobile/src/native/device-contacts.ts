import { Contact, ContactField, getPermissionsAsync, requestPermissionsAsync, type PartialContactDetails } from 'expo-contacts';
import type { SQLiteDatabase } from 'expo-sqlite';
import { Platform } from 'react-native';
import { readDeviceContactFacts } from '../../../../packages/domain/src/device-contact-facts';
import { stageDeviceContact } from '@/data/device-contacts';
import { ProviderSourceError } from '../../../../packages/domain/src/provider-sources';
import type { DeviceReadResult } from '@/data/device-contact-reconciliation';
const fields = [ContactField.FULL_NAME, ContactField.EMAILS, ContactField.PHONES] as const;
function factsFromDetails(details: PartialContactDetails<typeof fields>) {
  return readDeviceContactFacts({ device_id: details.id, name: details.fullName?.trim() || null,
    emails: (details.emails ?? []).filter((method) => method.address?.trim()).map((method) => ({ source_id: method.id || null, value: method.address!, label: method.label?.trim() || null })),
    phones: (details.phones ?? []).filter((method) => method.number?.trim()).map((method) => ({ source_id: method.id || null, value: method.number!, label: method.label?.trim() || null })) });
}
export async function pickDeviceContact(db: SQLiteDatabase) {
  if (Platform.OS === 'web') throw new Error('Open Everclose on your phone to choose a system contact.');
  let permission = await getPermissionsAsync();
  if (!permission.granted && permission.canAskAgain) permission = await requestPermissionsAsync();
  if (!permission.granted) throw new ProviderSourceError('Contacts access is off. Allow access in iPhone Settings, or add this person manually.');
  const contact = await Contact.presentPicker();
  if (!contact) return null;
  const details = await contact.getDetails(fields).catch(() => {
    throw new ProviderSourceError(permission.accessPrivileges === 'limited'
      ? 'This contact is outside the allowed selection or is no longer available. Use Manage allowed contacts, then choose it again.'
      : 'That contact is no longer available. Choose it again or add fields manually.');
  });
  const after = await getPermissionsAsync();
  if (!after.granted || permission.accessPrivileges !== after.accessPrivileges) throw new ProviderSourceError('Contacts access changed during this read. Choose the allowed contact again.');
  return stageDeviceContact(db, factsFromDetails({ ...details, id: contact.id }));
}
/** Foreground recurring reads never request or expand Contacts permission. */
export async function readLinkedDeviceContact(externalId: string): Promise<DeviceReadResult> {
  if (Platform.OS !== 'ios') return { state: 'error', reason: 'iphone_required' };
  const before = await getPermissionsAsync();
  if (!before.granted) return { state: 'access_lost', reason: 'permission_required' };
  try {
    const details = await new Contact(externalId).getDetails(fields);
    const after = await getPermissionsAsync();
    if (!after.granted || before.accessPrivileges !== after.accessPrivileges) return { state: 'access_lost', reason: 'permission_changed' };
    const facts = factsFromDetails(details);
    if (facts.device_id !== externalId) return { state: 'error', reason: 'identity_changed' };
    return { state: 'available', facts };
  } catch {
    const after = await getPermissionsAsync();
    if (!after.granted || before.accessPrivileges !== after.accessPrivileges) return { state: 'access_lost', reason: 'permission_changed' };
    // The installed SDK folds several CNContactStore errors into not-found; never infer deletion.
    return { state: 'unavailable', reason: before.accessPrivileges === 'limited' ? 'outside_allowed_selection_or_unavailable' : 'not_found_or_store_error' };
  }
}
export async function readDeviceContactPage(name: string, offset: number, requestPermission: boolean) {
  if (Platform.OS !== 'ios') throw new ProviderSourceError('Open Everclose on your iPhone to browse Contacts.');
  if (typeof name !== 'string' || name.length > 200 || /[\u0000-\u001f\u007f]/u.test(name) || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new ProviderSourceError('Use a valid Contacts search and page.');
  let permission = await getPermissionsAsync();
  if (!permission.granted && requestPermission && permission.canAskAgain) permission = await requestPermissionsAsync();
  if (!permission.granted) throw new ProviderSourceError('Contacts access is off. Allow access in iPhone Settings to browse people.');
  const details = await Contact.getAllDetails(fields, { name: name.trim() || undefined, offset, limit: 51 });
  const after = await getPermissionsAsync();
  if (!after.granted || permission.accessPrivileges !== after.accessPrivileges) throw new ProviderSourceError('Contacts access changed during this read. Refresh the allowed people.');
  if (!Array.isArray(details) || details.length > 51) throw new ProviderSourceError('The Contacts page was too large. Search for a name and try again.');
  const rows = details.slice(0, 50).map(factsFromDetails);
  if (new Set(rows.map((row) => row.device_id)).size !== rows.length) throw new ProviderSourceError('The address book changed during this page. Refresh before choosing someone.');
  return { rows, more: details.length > 50, offset, limited: after.accessPrivileges === 'limited' };
}
