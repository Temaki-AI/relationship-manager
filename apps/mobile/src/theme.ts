import { Platform } from 'react-native';
import { elevation } from '../../../packages/design/src/tokens';

export { colors as palette, spacing, radii, typeScale, targets, avatarTone } from '../../../packages/design/src/tokens';

export const fonts = {
  display: Platform.select({ ios: 'Avenir Next Demi Bold', default: 'sans-serif-medium' }),
  body: Platform.select({ ios: 'Avenir Next', default: 'sans-serif' }),
  bodyMedium: Platform.select({ ios: 'Avenir Next Medium', default: 'sans-serif-medium' }),
  bodyDemi: Platform.select({ ios: 'Avenir Next Demi Bold', default: 'sans-serif' }),
} as const;

export const shadows = {
  card: elevation.nativeCard,
} as const;
