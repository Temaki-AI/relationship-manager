import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { avatarTones, colors, createThemeCss } from '../packages/design/src/tokens.ts';

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map(start => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}
function contrast(first: string, second: string) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('web CSS is generated from the same tokens used by native', () => {
  assert.equal(readFileSync(new URL('../app/design-tokens.css', import.meta.url), 'utf8'), createThemeCss(), 'Run npm run design:tokens after changing tokens.');
});

test('text, semantic feedback and avatar colors meet WCAG AA', () => {
  const pairs = [
    [colors.ink, colors.canvas], [colors.ink, colors.surface],
    [colors.muted, colors.canvas], [colors.muted, colors.surfaceWarm],
    [colors.white, colors.primary], [colors.white, colors.primaryPressed], [colors.white, colors.danger],
    [colors.primary, colors.primarySoft], [colors.moss, colors.mossSoft],
    [colors.amber, colors.amberSoft], [colors.danger, colors.dangerSoft], [colors.info, colors.infoSoft],
    ...avatarTones.map(tone => [tone.foreground, tone.background]),
  ];
  for (const [foreground, background] of pairs) {
    assert(contrast(foreground, background) >= 4.5, `${foreground} on ${background}: ${contrast(foreground, background).toFixed(2)}:1`);
  }
});

test('field boundaries and focus indicators have at least 3:1 contrast', () => {
  for (const surface of [colors.surface, colors.canvas, colors.surfaceWarm]) {
    for (const indicator of [colors.input, colors.primary, colors.danger]) {
      assert(contrast(indicator, surface) >= 3, `${indicator} on ${surface}`);
    }
  }
});
