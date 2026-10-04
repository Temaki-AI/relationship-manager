import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('the native mobile app remains isolated from the production web runtime', () => {
  const rootTypeScript = JSON.parse(readFileSync('tsconfig.json', 'utf8')) as {
    exclude?: string[];
  };
  assert.ok(rootTypeScript.exclude?.includes('apps/mobile'));
  assert.match(readFileSync('eslint.config.mjs', 'utf8'), /'apps\/mobile\/\*\*'/);
  assert.match(readFileSync('.dockerignore', 'utf8'), /^apps\/mobile$/m);

  const rootPackage = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts?: Record<string, string>;
  };
  assert.equal(rootPackage.scripts?.['test:mobile'], 'npm --prefix apps/mobile run validate');
});

test('mobile configuration declares private native capabilities without a web wrapper', () => {
  const appConfig = JSON.parse(readFileSync('apps/mobile/app.json', 'utf8')) as {
    expo?: {
      name?: string;
      scheme?: string;
      ios?: { bundleIdentifier?: string };
      plugins?: unknown[];
    };
  };
  assert.equal(appConfig.expo?.name, 'Everclose');
  assert.equal(appConfig.expo?.scheme, 'bonds');
  assert.equal(appConfig.expo?.ios?.bundleIdentifier, 'com.fernandoamaral.bonds');
  const plugins = JSON.stringify(appConfig.expo?.plugins || []);
  for (const plugin of [
    'expo-contacts',
    'expo-notifications',
    'expo-sqlite',
    'expo-secure-store',
    'expo-local-authentication',
  ]) {
    assert.match(plugins, new RegExp(plugin));
  }
  assert.match(plugins, /choose a person/);

  const mobilePackage = JSON.parse(readFileSync('apps/mobile/package.json', 'utf8')) as {
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
    overrides?: { xcode?: { uuid?: string } };
  };
  assert.equal(mobilePackage.dependencies?.['react-native-webview'], undefined);
  assert.equal(mobilePackage.dependencies?.['@segment/analytics-react-native'], undefined);
  assert.match(mobilePackage.scripts?.validate || '', /typecheck.*test.*lint.*export:ios/);
  assert.equal(mobilePackage.overrides?.xcode?.uuid, '^11.1.1');
});

test('CI audits and bundles the isolated iOS package', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(workflow, /working-directory: apps\/mobile\s+run: npm ci/);
  assert.match(workflow, /working-directory: apps\/mobile\s+run: npm audit --audit-level=moderate/);
  assert.match(workflow, /working-directory: apps\/mobile\s+run: npm run validate/);
});
