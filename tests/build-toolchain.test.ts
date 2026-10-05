import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const loader = require('@esbuild-kit/core-utils') as {
  transformSync(source: string, file: string, options: Record<string, unknown>): { code: string };
  transform(source: string, file: string, options: Record<string, unknown>): Promise<{ code: string }>;
};

function execute(code: string) {
  const compiled = { exports: {} as Record<string, unknown> };
  new Function('module', 'exports', code)(compiled, compiled.exports);
  return compiled.exports;
}

test('the patched Drizzle TypeScript loader preserves configuration exports', () => {
  const source = `type Config = { dialect: 'sqlite'; schema: string; out: string };
    const config: Config = { dialect: 'sqlite', schema: './lib/cloud/schema.ts', out: './drizzle' };
    export default config;`;
  const result = loader.transformSync(source, '/tmp/everclose-config-fixture.ts', { format: 'cjs' });
  assert.deepEqual(execute(result.code).default, {
    dialect: 'sqlite', schema: './lib/cloud/schema.ts', out: './drizzle',
  });
});

test('the patched loader preserves async compilation and TypeScript enum behavior', async () => {
  const result = await loader.transform(`enum State { Waiting = 2, Ready }
    export function ready(value: State): boolean { return value === State.Ready; }
    export const value: State = State.Ready;`, '/tmp/everclose-loader-fixture.ts', { format: 'cjs' });
  const exports = execute(result.code);
  assert.equal(exports.value, 3);
  assert.equal((exports.ready as (value: number) => boolean)(3), true);
  assert.equal((exports.ready as (value: number) => boolean)(2), false);
});
