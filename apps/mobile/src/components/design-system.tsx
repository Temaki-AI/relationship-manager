import type { ReactNode } from 'react';
import { forwardRef, useState } from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { getInitials } from '@/domain/contact';
import { SymbolView } from 'expo-symbols';
import { avatarTone, fonts, palette, radii, shadows, spacing, targets, typeScale } from '@/theme';

export function BrandLockup() {
  return (
    <View style={styles.brandLockup} accessibilityLabel="Everclose">
      <SymbolView name="heart.fill" tintColor={palette.primary} size={24} />
      <Text maxFontSizeMultiplier={2} style={styles.brandName}>Everclose</Text>
    </View>
  );
}

export function Surface({ children, style, tone = 'default' }: { children: ReactNode; style?: StyleProp<ViewStyle>; tone?: 'default' | 'warm' | 'rose' | 'sage' }) {
  const backgroundColor = tone === 'rose' ? palette.primarySoft : tone === 'sage' ? palette.mossSoft : tone === 'warm' ? palette.surfaceWarm : palette.surface;
  return <View style={[styles.surface, shadows.card, { backgroundColor }, style]}>{children}</View>;
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <Text style={styles.eyebrow}>{children}</Text>;
}

/** Shared field chrome; callers retain keyboard, draft and validation behavior. */
export const FormInput = forwardRef<TextInput, TextInputProps & { invalid?: boolean }>(function FormInput(
  { style, invalid = false, onFocus, onBlur, multiline, editable = true, ...props }, ref,
) {
  const [focused, setFocused] = useState(false);
  return <TextInput {...props} ref={ref} multiline={multiline} editable={editable}
    placeholderTextColor={props.placeholderTextColor ?? palette.muted}
    onFocus={(event) => { setFocused(true); onFocus?.(event); }}
    onBlur={(event) => { setFocused(false); onBlur?.(event); }}
    style={[styles.input, multiline && styles.inputMultiline, style,
      !editable && styles.inputDisabled, focused && styles.inputFocused, invalid && styles.inputInvalid]} />;
});

export function SectionHeading({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <View style={styles.sectionHeading}>
      <Text accessibilityRole="header" maxFontSizeMultiplier={2} style={styles.sectionTitle}>{title}</Text>
      {action}
    </View>
  );
}

export function Avatar({ name, size = 48, photo = null }: { name: string; size?: number; photo?: string | null }) {
  const [failedPhoto, setFailedPhoto] = useState<string | null>(null);
  const tone = avatarTone(name);
  return (
    <View
      accessible={false}
      style={[
        styles.avatar,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: tone.background },
      ]}
    >
      {photo && photo !== failedPhoto ? <Image accessible={false} source={{ uri: photo }} resizeMode="cover"
        style={{ width: size, height: size, borderRadius: size / 2 }} onError={() => setFailedPhoto(photo)} /> : <Text allowFontScaling={false} style={[styles.avatarText, { color: tone.foreground, fontSize: Math.max(12, Math.round(size * 0.32)) }]}>
        {getInitials(name)}
      </Text>}
    </View>
  );
}

export function ActionButton({
  label,
  onPress,
  disabled = false,
  selected,
  variant = 'primary',
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
  variant?: 'primary' | 'secondary' | 'quiet' | 'destructive';
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionButton,
        variant === 'primary' && styles.actionPrimary,
        variant === 'secondary' && styles.actionSecondary,
        variant === 'quiet' && styles.actionQuiet,
        variant === 'destructive' && styles.actionDestructive,
        pressed && !disabled && styles.actionPressed,
        disabled && styles.actionDisabled,
      ]}
    >
      <Text maxFontSizeMultiplier={2} style={[
        styles.actionLabel,
        variant === 'primary' || variant === 'destructive' ? styles.actionPrimaryLabel : styles.actionSecondaryLabel,
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
      <Text maxFontSizeMultiplier={2} style={[
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
  input: { minHeight: targets.comfortable, borderRadius: radii.control, borderWidth: 1, borderColor: palette.input,
    backgroundColor: palette.surface, color: palette.ink, fontFamily: fonts.body, fontSize: typeScale.body.fontSize,
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  inputMultiline: { minHeight: 96, textAlignVertical: 'top' },
  inputFocused: { borderColor: palette.primary, borderWidth: 2 },
  inputInvalid: { borderColor: palette.danger, borderWidth: 2 },
  inputDisabled: { backgroundColor: palette.surfaceWarm, opacity: 0.6 },
  brandLockup: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  brandName: { color: palette.primary, fontFamily: fonts.bodyDemi, fontSize: 14, letterSpacing: 2, textTransform: 'uppercase' },
  surface: { backgroundColor: palette.surface, borderRadius: radii.card, borderWidth: StyleSheet.hairlineWidth, borderColor: palette.line },
  eyebrow: {
    color: palette.primary,
    fontFamily: fonts.bodyDemi,
    fontSize: typeScale.body.fontSize,
    letterSpacing: 0,
  },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
  sectionTitle: { ...typeScale.section, color: palette.ink, fontFamily: fonts.bodyDemi, flexShrink: 1 },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: palette.white, fontFamily: fonts.bodyDemi, fontWeight: '700' },
  actionButton: {
    minHeight: targets.comfortable,
    borderRadius: radii.control,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  actionPrimary: { backgroundColor: palette.primary, borderColor: palette.primary },
  actionDestructive: { backgroundColor: palette.danger, borderColor: palette.danger },
  actionSecondary: { backgroundColor: palette.primarySoft, borderColor: palette.primarySoft },
  actionQuiet: { backgroundColor: 'transparent', borderColor: 'transparent' },
  actionPressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
  actionDisabled: { opacity: 0.45 },
  actionLabel: { fontFamily: fonts.bodyDemi, fontSize: 15, fontWeight: '700', textAlign: 'center' },
  actionPrimaryLabel: { color: palette.white },
  actionSecondaryLabel: { color: palette.primary },
  pill: { alignSelf: 'flex-start', borderRadius: radii.pill, paddingHorizontal: 10, paddingVertical: 5 },
  pillMoss: { backgroundColor: palette.mossSoft },
  pillAmber: { backgroundColor: palette.amberSoft },
  pillRose: { backgroundColor: palette.primarySoft },
  pillText: { fontFamily: fonts.bodyDemi, fontSize: 11, fontWeight: '700' },
  pillTextMoss: { color: palette.moss },
  pillTextAmber: { color: palette.amber },
  pillTextRose: { color: palette.primary },
});
