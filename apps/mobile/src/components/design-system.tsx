import type { ReactNode } from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { getInitials } from '@/domain/contact';
import { fonts, palette, shadows } from '@/theme';

export function BrandLockup() {
  return (
    <View style={styles.brandLockup} accessibilityLabel="Everclose">
      <Image source={require('@/assets/images/icon.png')} style={styles.brandIcon} />
      <Text style={styles.brandName}>Everclose</Text>
    </View>
  );
}

export function Surface({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.surface, shadows.card, style]}>{children}</View>;
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <Text style={styles.eyebrow}>{children}</Text>;
}

export function SectionHeading({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <View style={styles.sectionHeading}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {action}
    </View>
  );
}

export function Avatar({ name, size = 48 }: { name: string; size?: number }) {
  const colors = ['#9F2447', '#315C72', '#2D6D55', '#7A4A1D', '#6D3B67'];
  const colorIndex = Array.from(name).reduce((sum, character) => sum + character.charCodeAt(0), 0)
    % colors.length;
  return (
    <View
      accessible={false}
      style={[
        styles.avatar,
        { width: size, height: size, borderRadius: Math.round(size * 0.36), backgroundColor: colors[colorIndex] },
      ]}
    >
      <Text style={[styles.avatarText, { fontSize: Math.max(12, Math.round(size * 0.32)) }]}>
        {getInitials(name)}
      </Text>
    </View>
  );
}

export function ActionButton({
  label,
  onPress,
  disabled = false,
  variant = 'primary',
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'quiet';
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionButton,
        variant === 'primary' && styles.actionPrimary,
        variant === 'secondary' && styles.actionSecondary,
        variant === 'quiet' && styles.actionQuiet,
        pressed && !disabled && styles.actionPressed,
        disabled && styles.actionDisabled,
      ]}
    >
      <Text style={[
        styles.actionLabel,
        variant === 'primary' ? styles.actionPrimaryLabel : styles.actionSecondaryLabel,
      ]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function StatusPill({ tone, label }: { tone: 'moss' | 'amber' | 'rose'; label: string }) {
  return (
    <View style={[
      styles.pill,
      tone === 'moss' && styles.pillMoss,
      tone === 'amber' && styles.pillAmber,
      tone === 'rose' && styles.pillRose,
    ]}>
      <Text style={[
        styles.pillText,
        tone === 'moss' && styles.pillTextMoss,
        tone === 'amber' && styles.pillTextAmber,
        tone === 'rose' && styles.pillTextRose,
      ]}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  brandLockup: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  brandIcon: { width: 34, height: 34, borderRadius: 10 },
  brandName: { color: palette.ink, fontFamily: fonts.display, fontSize: 25, fontWeight: '700' },
  surface: { backgroundColor: palette.surface, borderRadius: 26, borderWidth: 1, borderColor: palette.line },
  eyebrow: {
    color: palette.primary,
    fontFamily: fonts.bodyDemi,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: { color: palette.ink, fontFamily: fonts.display, fontSize: 24, fontWeight: '700' },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: palette.white, fontFamily: fonts.bodyDemi, fontWeight: '700' },
  actionButton: {
    minHeight: 50,
    borderRadius: 17,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  actionPrimary: { backgroundColor: palette.primary, borderColor: palette.primary },
  actionSecondary: { backgroundColor: palette.surface, borderColor: palette.line },
  actionQuiet: { backgroundColor: palette.primarySoft, borderColor: palette.primarySoft },
  actionPressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
  actionDisabled: { opacity: 0.45 },
  actionLabel: { fontFamily: fonts.bodyDemi, fontSize: 15, fontWeight: '700' },
  actionPrimaryLabel: { color: palette.white },
  actionSecondaryLabel: { color: palette.primary },
  pill: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  pillMoss: { backgroundColor: palette.mossSoft },
  pillAmber: { backgroundColor: palette.amberSoft },
  pillRose: { backgroundColor: palette.primarySoft },
  pillText: { fontFamily: fonts.bodyDemi, fontSize: 11, fontWeight: '700' },
  pillTextMoss: { color: palette.moss },
  pillTextAmber: { color: palette.amber },
  pillTextRose: { color: palette.primary },
});
