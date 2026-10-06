import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import config from '../tailwind.config.ts';

const loadPackage = createRequire(import.meta.url);

test('the styling pipeline preserves interactive and responsive selectors', async () => {
  const output = await postcss([tailwind({
    ...config,
    content: [{
      raw: 'group-hover:text-primary peer-checked:bg-primary md:hover:bg-primary lg:flex [&>a:focus-visible]:underline aria-expanded:bg-primary data-[state=open]:block dark:text-foreground',
      extension: 'html',
    }],
  })]).process('@tailwind utilities; .profile { @apply p-4 md:p-6; }', { from: undefined });

  const declarations = new Map<string, Map<string, string>>();
  output.root.walkRules((rule) => {
    const values = new Map<string, string>();
    rule.walkDecls((declaration) => { values.set(declaration.prop, declaration.value); });
    declarations.set(rule.selector, values);
  });
  assert.equal(declarations.get('.group:hover .group-hover\\:text-primary')?.get('color'), 'hsl(var(--primary))');
  assert.equal(declarations.get('.peer:checked ~ .peer-checked\\:bg-primary')?.get('background-color'), 'hsl(var(--primary))');
  assert.equal(declarations.get('.aria-expanded\\:bg-primary[aria-expanded="true"]')?.get('background-color'), 'hsl(var(--primary))');
  assert.equal(declarations.get('.data-\\[state\\=open\\]\\:block[data-state="open"]')?.get('display'), 'block');
  assert.equal(declarations.get('.md\\:hover\\:bg-primary:hover')?.get('background-color'), 'hsl(var(--primary))');
  assert.equal(declarations.get('.lg\\:flex')?.get('display'), 'flex');
  assert.equal(declarations.get('.dark\\:text-foreground')?.get('color'), 'hsl(var(--foreground))');
  assert.equal(declarations.get('.\\[\\&\\>a\\:focus-visible\\]\\:underline>a:focus-visible')?.get('text-decoration-line'), 'underline');
  const queries: string[] = [];
  output.root.walkAtRules('media', (rule) => { queries.push(rule.params); });
  assert.deepEqual(queries, ['(min-width: 768px)', '(min-width: 768px)', '(min-width: 1024px)', '(prefers-color-scheme: dark)']);
  assert.equal(output.warnings().length, 0);

  const nested = await postcss([loadPackage('postcss-nested')]).process(
    '.profile, .card { & > :is(a, button):focus-visible { outline: 2px solid red; } @media (min-width: 640px) { &[data-state="open"] .child { display: flex; } } }',
    { from: undefined },
  );
  const selectors: string[] = [];
  nested.root.walkRules((rule) => { selectors.push(rule.selector); });
  assert.deepEqual(selectors, [
    '.profile > :is(a, button):focus-visible, .card > :is(a, button):focus-visible',
    '.profile[data-state="open"] .child, .card[data-state="open"] .child',
  ]);
  assert.equal(nested.warnings().length, 0);
});

test('a long flat selector parses and serializes within a bounded subprocess', () => {
  // A separate process makes the deadline enforceable even if parsing blocks its thread.
  const child = spawnSync(process.execPath, ['--input-type=commonjs', '-e', `
    const assert = require('node:assert/strict');
    const parser = require('postcss-selector-parser');
    const count = 200000;
    const selector = '.a'.repeat(count);
    const root = parser().astSync(selector);
    assert.equal(root.nodes.length, 1);
    assert.equal(root.nodes[0].nodes.length, count);
    assert.equal(root.toString(), selector);
    process.stdout.write(String(count));
  `], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '200000');
});
