import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import * as SplashScreen from 'expo-splash-screen';
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ActivityIndicator, AppState, Modal, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ActionButton } from '@/components/design-system';
import { fonts, palette } from '@/theme';
import { AppLockController, type LockAppState } from './app-lock-controller';

const key = 'everclose.device-app-lock.v1';
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const LockContext = createContext<AppLockController | null>(null);
const lifecycle = (value: string | null): LockAppState => value === 'active' || value === 'inactive' || value === 'background' ? value : 'unknown';

export function AppLockProvider({ children }: { children: ReactNode }) {
  const [controller] = useState(() => new AppLockController({
    read: () => Platform.OS === 'web' ? Promise.resolve(null) : SecureStore.getItemAsync(key, options),
    write: (value) => SecureStore.setItemAsync(key, value, options),
    authenticate: async () => {
      if (Platform.OS === 'web' || await LocalAuthentication.getEnrolledLevelAsync() < LocalAuthentication.SecurityLevel.SECRET) return false;
      return (await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock Everclose',
        disableDeviceFallback: false, cancelLabel: 'Cancel', fallbackLabel: 'Use device passcode' })).success;
    },
  }, lifecycle(AppState.currentState)));
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => controller.lifecycle(lifecycle(state)));
    void controller.load();
    return () => { subscription.remove(); controller.lockNow(); };
  }, [controller]);
  return <LockContext.Provider value={controller}>{children}</LockContext.Provider>;
}

export function useAppLock() {
  const controller = useContext(LockContext);
  if (!controller) throw new Error('App lock provider is missing.');
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const contentVisible = state.loaded && (state.enabled === false || state.enabled === true && !state.locked) && state.appState === 'active';
  return { ...state, contentVisible, supported: Platform.OS !== 'web', reload: () => controller.load(),
    unlock: () => controller.unlock(), repair: () => controller.repair(), changeEnabled: (enabled: boolean) => controller.changeEnabled(enabled), lockNow: () => controller.lockNow() };
}

export function AppLockGate({ children }: { children: ReactNode }) {
  const lock = useAppLock();
  const visible = lock.contentVisible;
  useEffect(() => { void SplashScreen.hideAsync().catch(() => {}); }, []);
  const cover = <View style={styles.cover} accessibilityViewIsModal><ScrollView contentContainerStyle={styles.coverContent}>
      <Text style={styles.title}>Everclose</Text>
      {lock.appState === 'active' && <>
        <Text style={styles.body}>{lock.loaded ? 'Your private journal is locked.' : 'Checking the device lock setting…'}</Text>
        {lock.error && <Text style={styles.body} accessibilityRole="alert">{lock.error}</Text>}
        {!lock.loaded && !lock.error || lock.authenticating || lock.saving ? <ActivityIndicator color={palette.primary} />
          : lock.loaded ? <ActionButton label="Unlock Everclose" onPress={() => { void lock.unlock(); }} />
            : <ActionButton label="Retry lock setting" onPress={() => { void lock.reload(); }} />}
        {!lock.loaded && lock.error && !lock.authenticating && !lock.saving && <ActionButton label="Verify device and restore lock" variant="secondary" onPress={() => { void lock.repair(); }} />}
      </>}
    </ScrollView></View>;
  return <View style={styles.root}>
    <View style={[styles.root, !visible && styles.concealed]} pointerEvents={visible ? 'auto' : 'none'}
      accessibilityElementsHidden={!visible} importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}>
      {lock.opened && children}
    </View>
    {!visible && !lock.coverPresented && lock.appState !== 'active' && cover}
    <Modal visible={lock.coverPresented} animationType="none" presentationStyle="fullScreen" onRequestClose={() => {}}>
      {cover}
    </Modal>
  </View>;
}
const styles = StyleSheet.create({
  root: { flex: 1 }, concealed: { opacity: 0 },
  cover: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: palette.canvas },
  coverContent: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 20 },
  title: { fontFamily: fonts.display, color: palette.ink, fontSize: 36 },
  body: { fontFamily: fonts.body, color: palette.muted, fontSize: 16, lineHeight: 24, textAlign: 'center' },
});
