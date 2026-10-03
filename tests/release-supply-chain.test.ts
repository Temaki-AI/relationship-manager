import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const SHA_PATTERN = /@[a-f0-9]{40}(?:\s+#\s+v\d[^\n]*)?/g;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('CI actions and runtime versions are immutable and least-privileged', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.equal((workflow.match(SHA_PATTERN) || []).length, 6);
  assert.doesNotMatch(workflow, /uses:\s+[^\s]+@v\d/);
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /permissions:\s+contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /node-version-file: \.nvmrc/);
  assert.match(workflow, /- run: npm ci/);
  assert.match(workflow, /npm audit --audit-level=moderate/);
  assert.match(workflow, /playwright install --with-deps chromium/);
  assert.match(workflow, /npx playwright test/);
  assert.match(workflow, /retention-days: 14/);
  assert.match(workflow, /cloud-validate:/);
  assert.match(workflow, /npm run build:cloud/);
  assert.match(workflow, /BONDS_E2E_CLOUD_UI: "true"/);
  assert.match(workflow, /tests\/e2e\/cloud-import\.spec\.ts/);
});

test('container stages use one exact Node release and immutable manifest digest', () => {
  const dockerfile = readFileSync('Dockerfile', 'utf8');
  assert.match(
    dockerfile,
    /ARG NODE_IMAGE=node:22\.21\.1-bookworm-slim@sha256:[a-f0-9]{64}/
  );
  assert.equal((dockerfile.match(/FROM \$\{NODE_IMAGE\}/g) || []).length, 2);
  assert.doesNotMatch(dockerfile, /FROM node:(?:latest|\d+-(?:bookworm|alpine))/);
  assert.doesNotMatch(dockerfile, /^# syntax=/m);
  assert.match(dockerfile, /USER node/);

  const compose = readFileSync('compose.yaml', 'utf8');
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop:\s+- ALL/);
  assert.match(compose, /no-new-privileges:true/);
});

test('local package tooling and private build exclusions are reproducible', () => {
  assert.equal(readFileSync('.nvmrc', 'utf8').trim(), '22.21.1');
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
    packageManager?: string;
    engines?: { node?: string };
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.equal(packageJson.packageManager, 'npm@10.9.4');
  assert.equal(packageJson.engines?.node, '>=22.0.0');
  assert.equal(packageJson.devDependencies?.['@axe-core/playwright'], '4.12.1');
  assert.equal(packageJson.devDependencies?.['@playwright/test'], '1.61.0');
  assert.match(packageJson.scripts?.['test:e2e'] || '', /playwright test/);

  const dockerIgnore = readFileSync('.dockerignore', 'utf8');
  for (const privatePath of ['.git', '.github', '.claude', 'node_modules', 'data', '.env', '.env.*']) {
    assert.match(dockerIgnore, new RegExp(`^${escapeRegex(privatePath)}\\s*$`, 'm'));
  }
});

test('cloud framework dependencies stay on a patched compatible line', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  const version = (name: string) => lock.packages[`node_modules/${name}`].version as string;
  assert.equal(manifest.dependencies.next, version('next'));
  assert.equal(manifest.devDependencies['eslint-config-next'], version('next'));
  assert.equal(manifest.dependencies['@opennextjs/cloudflare'], version('@opennextjs/cloudflare'));
  assert.equal(manifest.devDependencies.wrangler, version('wrangler'));
  assert.equal(manifest.devDependencies.miniflare, version('miniflare'));
  assert.ok(Number(version('next').split('.')[2]) >= 27 && version('next').startsWith('15.5.'));
  assert.match(lock.packages['node_modules/@opennextjs/cloudflare'].peerDependencies.next, />=15\.5\.26/);
});
