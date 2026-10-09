import { StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AccountScreen from '../account';
import { fonts, palette, typeScale } from '@/theme';

export default function SettingsScreen() {
  return <SafeAreaView edges={['top', 'left', 'right']} style={styles.container}>
    <Text accessibilityRole="header" maxFontSizeMultiplier={2} style={styles.title}>Settings</Text>
    <AccountScreen />
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.canvas },
  title: { paddingHorizontal: 20, paddingTop: 12, fontFamily: fonts.display, ...typeScale.title, color: palette.ink },
});
