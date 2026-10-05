import { useIsFocused } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { fonts, palette } from '@/theme';

export type ChoiceOption = { label: string; onPress: () => void };
type Choice = { title: string; detail: string; options: ChoiceOption[] };

/** A scrollable choice list with a persistent Cancel control, including large text. */
export function useChoiceSheet() {
  const focused = useIsFocused();
  const [choice, setChoice] = useState<Choice | null>(null);
  const pending = useRef<(() => void) | null>(null);
  const focusState = useRef({ focused, generation: 0 });
  useEffect(() => {
    const current = focusState.current;
    current.focused = focused;
    if (!focused) void Promise.resolve().then(() => setChoice(null));
    return () => { current.focused = false; current.generation++; pending.current = null; };
  }, [focused]);
  function present(title: string, detail: string, options: ChoiceOption[]) {
    const current = focusState.current, generation = current.generation;
    if (!current.focused) return;
    pending.current = null;
    setChoice({ title, detail, options: options.map((option) => ({ label: option.label, onPress: () => {
      if (current.focused && current.generation === generation) option.onPress();
    } })) });
  }
  function dismiss() {
    const callback = pending.current; pending.current = null; callback?.();
  }
  function cancel() { pending.current = null; setChoice(null); }
  function select(option: ChoiceOption) {
    pending.current = option.onPress; setChoice(null);
    // iOS waits for the modal to close before presenting a permission/warning alert.
    if (Platform.OS !== 'ios') dismiss();
  }
  const sheet = <Modal visible={focused && choice !== null} animationType="slide" presentationStyle="fullScreen"
    onRequestClose={cancel} onDismiss={dismiss}>
    <SafeAreaView style={styles.safeArea} accessibilityViewIsModal>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>{choice?.title}</Text>
        <Text style={styles.detail}>{choice?.detail}</Text>
        {choice?.options.map((option) => <Pressable key={option.label} accessibilityRole="button" accessibilityLabel={option.label}
          onPress={() => select(option)} style={({ pressed }) => [styles.option, pressed && styles.pressed]}>
          <Text style={styles.optionText}>{option.label}</Text>
        </Pressable>)}
      </ScrollView>
      <View style={styles.footer}>
        <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={cancel}
          style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}>
          <Text style={styles.optionText}>Cancel</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  </Modal>;
  return { present, sheet };
}
const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.canvas },
  content: { padding: 20, gap: 16 },
  title: { color: palette.ink, fontFamily: fonts.display, fontSize: 26, fontWeight: '700' },
  detail: { color: palette.muted, fontFamily: fonts.body, fontSize: 15, lineHeight: 22 },
  option: { minHeight: 44, padding: 16, borderRadius: 16, backgroundColor: palette.primarySoft },
  optionText: { color: palette.primary, fontFamily: fonts.bodyDemi, fontSize: 17 },
  footer: { padding: 16, borderTopWidth: 1, borderTopColor: palette.line },
  cancel: { minHeight: 44, alignItems: 'center', justifyContent: 'center', padding: 14, borderRadius: 16, backgroundColor: palette.surfaceWarm },
  pressed: { opacity: 0.72 },
});
