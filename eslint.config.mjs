import js from '@eslint/js';
import { FlatCompat } from '@eslint/eslintrc';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

const config = [
  {
    ignores: [
      '.next/**',
      '.next.reset-dashboard-*/**',
      '.next.stale-dev-cache/**',
      '.open-next/**',
      '.wrangler/**',
      'apps/mobile/**',
      'node_modules/**',
      'data/**',
      'next-env.d.ts',
      'cloudflare-env.d.ts',
    ],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
];

export default config;
