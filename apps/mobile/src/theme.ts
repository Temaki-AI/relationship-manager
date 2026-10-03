import { Platform } from 'react-native';

export const palette = {
  canvas: '#FFF8F4',
  surface: '#FFFFFF',
  surfaceWarm: '#FFF0EB',
  ink: '#251C1C',
  muted: '#746768',
  faint: '#A99B9B',
  line: '#EADFDA',
  primary: '#C4143C',
  primaryPressed: '#9F1031',
  primarySoft: '#FCE5EA',
  moss: '#216A51',
  mossSoft: '#E2F1E9',
  amber: '#9A5B05',
  amberSoft: '#FFF0CF',
  danger: '#A82121',
  white: '#FFFFFF',
} as const;

export const fonts = {
  display: Platform.select({ ios: 'Georgia', default: 'serif' }),
  body: Platform.select({ ios: 'Avenir Next', default: 'sans-serif' }),
  bodyMedium: Platform.select({ ios: 'Avenir Next Medium', default: 'sans-serif-medium' }),
  bodyDemi: Platform.select({ ios: 'Avenir Next Demi Bold', default: 'sans-serif' }),
} as const;

export const shadows = {
  card: {
    shadowColor: '#54202D',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 22,
    elevation: 3,
  },
} as const;
