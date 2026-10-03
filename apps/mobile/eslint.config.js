import { defineConfig } from 'eslint/config';
import expoConfig from 'eslint-config-expo/flat.js';

export default defineConfig([
  expoConfig,
  {
    ignores: ['.expo/**', 'dist/**', 'node_modules/**'],
    rules: {
      'no-console': 'error',
    },
  },
]);
