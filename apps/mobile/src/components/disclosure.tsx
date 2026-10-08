import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { fonts, palette } from '@/theme';

export function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  return <View style={styles.container}>
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded }}
      onPress={() => setExpanded((value) => !value)} style={styles.trigger}>
      <Text maxFontSizeMultiplier={2} style={styles.title}>{title}</Text>
      <Text allowFontScaling={false} accessibilityElementsHidden importantForAccessibility="no" style={styles.indicator}>{expanded ? '−' : '+'}</Text>
    </Pressable>
    {expanded && <View style={styles.content}>{children}</View>}
  </View>;
}

const styles = StyleSheet.create({
  container: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line },
  trigger: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  title: { flex: 1, fontFamily: fonts.bodyDemi, color: palette.ink, fontSize: 15 },
  indicator: { fontFamily: fonts.body, color: palette.muted, fontSize: 22 },
  content: { gap: 12, paddingBottom: 12 },
});
