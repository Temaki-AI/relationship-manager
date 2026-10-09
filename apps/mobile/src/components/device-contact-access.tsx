import { Contact, getPermissionsAsync, type ContactsPermissionResponse } from 'expo-contacts';
import { useIsFocused } from 'expo-router';
import { useEffect, useState } from 'react';
import { AppState, Linking, Platform, StyleSheet, Text, View } from 'react-native';
import { ActionButton } from './design-system';
import { fonts, palette } from '@/theme';

export function DeviceContactAccess({ disabled = false }: { disabled?: boolean }) {
  const focused = useIsFocused();
  const [permission, setPermission] = useState<ContactsPermissionResponse | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (Platform.OS !== 'ios' || !focused) return;
    let active = true;
    const read = () => { void getPermissionsAsync().then((value) => { if (active) setPermission(value); }, () => { if (active) setError('Unable to check Contacts access.'); }); };
    read(); const listener = AppState.addEventListener('change', (state) => { if (state === 'active') read(); });
    return () => { active = false; listener.remove(); };
  }, [focused]);
  async function manage() {
    setBusy(true); setError('');
    try {
      if (permission?.accessPrivileges === 'limited') { await Contact.presentAccessPicker(); setPermission(await getPermissionsAsync()); }
      else await Linking.openSettings();
    } catch { setError('Unable to open Contacts access. You can change it in iPhone Settings.'); }
    finally { setBusy(false); }
  }
  if (Platform.OS !== 'ios' || !error && permission?.accessPrivileges !== 'limited' && (permission?.granted || permission?.canAskAgain !== false)) return null;
  const limited = permission?.accessPrivileges === 'limited';
  return <View style={styles.container}>
    <Text style={styles.body}>{limited ? 'Contacts access is limited to the people you allow. Managing access does not import anyone.' : 'Contacts access is off. You can allow access in iPhone Settings or add people manually.'}</Text>
    {!!error && <Text accessibilityRole="alert" style={styles.body}>{error}</Text>}
    <ActionButton label={limited ? 'Manage allowed contacts' : 'Open iPhone Settings'} variant="quiet" disabled={disabled || busy} onPress={() => void manage()} />
  </View>;
}
const styles = StyleSheet.create({ container: { gap: 8 }, body: { color: palette.muted, fontFamily: fonts.body, fontSize: 14, lineHeight: 21 } });
