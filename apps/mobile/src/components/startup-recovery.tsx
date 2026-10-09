import { Component, useEffect, type ReactNode } from 'react';
import * as SplashScreen from 'expo-splash-screen';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ActionButton, BrandLockup, Surface } from './design-system';
import { fonts, palette } from '@/theme';

export function StartupRecovery({ message, retryLabel = 'Try again', onRetry }: {
  message?: string; retryLabel?: string; onRetry: () => void;
}) {
  useEffect(() => { void SplashScreen.hideAsync().catch(() => {}); }, []);
  return <SafeAreaView style={styles.safeArea}>
    <ScrollView contentContainerStyle={styles.content}>
      <BrandLockup />
      <Surface style={styles.card}>
        <Text accessibilityRole="header" style={styles.title}>Unable to open Everclose</Text>
        <Text accessibilityRole="alert" style={styles.body}>{message ?? 'Everclose could not open the data saved on this iPhone. Unlock your iPhone, check its free storage, then try again.'}</Text>
        <Text style={styles.body}>Your saved data has not been reset. If the problem continues, keep the app installed so your offline changes remain on this phone.</Text>
        <ActionButton label={retryLabel} onPress={onRetry} />
      </Surface>
    </ScrollView>
  </SafeAreaView>;
}

// SQLiteProvider rethrows initialization errors during rendering. Catch them
// outside the provider, so retry mounts a fresh provider for the same database.
export class StartupBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <StartupRecovery onRetry={() => this.setState({ failed: false })} />
      : this.props.children;
  }
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.canvas },
  content: { flexGrow: 1, justifyContent: 'center', padding: 24, gap: 24 },
  card: { padding: 22, gap: 18 },
  title: { color: palette.ink, fontFamily: fonts.display, fontSize: 26, fontWeight: '700' },
  body: { color: palette.muted, fontFamily: fonts.body, fontSize: 15, lineHeight: 23 },
});
