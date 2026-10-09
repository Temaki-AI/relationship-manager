import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

function listTsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listTsxFiles(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

function getJsxTagName(node: ts.JsxElement): string {
  const tag = node.openingElement.tagName;
  return ts.isIdentifier(tag) ? tag.text : tag.getText();
}

function hslToRgb(hue: number, saturation: number, lightness: number): number[] {
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = s * Math.min(l, 1 - l);
  const channel = (offset: number) => {
    const segment = (offset + hue / 30) % 12;
    return l - chroma * Math.max(-1, Math.min(segment - 3, 9 - segment, 1));
  };
  return [channel(0), channel(8), channel(4)];
}

function relativeLuminance(rgb: number[]): number {
  const linear = rgb.map((channel) =>
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  );
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrastRatio(first: number[], second: number[]): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05)
    / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

function parseHslVariable(styles: string, variable: string): number[] {
  const match = styles.match(new RegExp(`--${variable}:\\s*(\\d+(?:\\.\\d+)?)\\s+(\\d+(?:\\.\\d+)?)%\\s+(\\d+(?:\\.\\d+)?)%`));
  assert(match, `Missing --${variable}`);
  return hslToRgb(Number(match[1]), Number(match[2]), Number(match[3]));
}

test('interactive elements are not nested inside one another', () => {
  const findings: string[] = [];
  const interactiveTags = new Set(['Link', 'a', 'Button', 'button', 'label']);

  for (const file of [
    ...listTsxFiles(join(projectRoot, 'app')),
    ...listTsxFiles(join(projectRoot, 'components')),
  ]) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );

    const visit = (node: ts.Node, interactiveParent?: string) => {
      let nextInteractiveParent = interactiveParent;
      if (ts.isJsxElement(node)) {
        const tag = getJsxTagName(node);
        if (interactiveTags.has(tag)) {
          if (interactiveParent) {
            const position = source.getLineAndCharacterOfPosition(node.getStart(source));
            findings.push(
              `${file.slice(projectRoot.length)}:${position.line + 1} nests <${tag}> inside <${interactiveParent}>`
            );
          }
          nextInteractiveParent = tag;
        }
      }
      ts.forEachChild(node, (child) => visit(child, nextInteractiveParent));
    };

    visit(source);
  }

  assert.deepEqual(findings, []);
});

test('route recovery experiences and reduced motion are part of the app shell', () => {
  for (const filename of ['loading.tsx', 'not-found.tsx', 'error.tsx', 'global-error.tsx']) {
    assert(readFileSync(join(projectRoot, 'app', filename), 'utf8').length > 100, filename);
  }

  const globalStyles = readFileSync(join(projectRoot, 'app', 'globals.css'), 'utf8');
  assert.match(globalStyles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(globalStyles, /:focus-visible/);

  const navigation = readFileSync(join(projectRoot, 'components', 'nav-header.tsx'), 'utf8');
  assert.match(navigation, /aria-current=/);
  assert.match(navigation, /aria-label="Main navigation"/);
  const addMenu = readFileSync(join(projectRoot, 'components', 'add-action-menu.tsx'), 'utf8');
  assert.match(addMenu, /aria-label="Add"/);
  assert.match(addMenu, /aria-expanded=\{open\}/);
  const sectionNav = readFileSync(join(projectRoot, 'components', 'section-nav.tsx'), 'utf8');
  assert.match(sectionNav, /aria-current=/);
});

test('brand and muted text tokens retain WCAG AA contrast', () => {
  const globalStyles = readFileSync(join(projectRoot, 'app', 'design-tokens.css'), 'utf8');
  const primary = parseHslVariable(globalStyles, 'primary');
  const primaryForeground = parseHslVariable(globalStyles, 'primary-foreground');
  const muted = parseHslVariable(globalStyles, 'muted');
  const mutedForeground = parseHslVariable(globalStyles, 'muted-foreground');
  const primaryTint = primary.map((channel) => channel * 0.1 + 0.9);

  assert(contrastRatio(primary, primaryForeground) >= 4.5);
  assert(contrastRatio(primary, primaryTint) >= 4.5);
  assert(contrastRatio(mutedForeground, muted) >= 4.5);
});

test('relationship forms and health states keep accessible names and text colors', () => {
  const contacts = readFileSync(join(projectRoot, 'app', 'contacts', 'page.tsx'), 'utf8');
  assert.match(contacts, /aria-label="Bulk action"/);
  assert.match(contacts, /aria-label={`Select \${contact\.name}`}/);
  assert.doesNotMatch(contacts, /health >= 75 \? 'text-emerald-600'/);
  assert.doesNotMatch(contacts, /health >= 50 \? 'text-amber-600'/);

  const contactDetail = readFileSync(join(projectRoot, 'app', 'contacts', '[id]', 'page.tsx'), 'utf8');
  for (const controlId of [
    'reminder-title',
    'reminder-at',
    'reminder-notes',
    'plan-type',
    'plan-date',
    'plan-summary',
    'plan-notes',
    'interaction-type',
    'interaction-date',
    'interaction-summary',
    'interaction-notes',
    'edit-interaction-type',
    'edit-interaction-date',
    'edit-interaction-summary',
    'edit-interaction-notes',
  ]) {
    assert.match(contactDetail, new RegExp(`htmlFor="${controlId}"`));
    assert.match(contactDetail, new RegExp(`id="${controlId}"`));
  }
  assert.match(contactDetail, /aria-label={`Edit interaction: \${interactionLabel}`}/);
  assert.match(contactDetail, /aria-label={`Delete interaction: \${interactionLabel}`}/);
  assert.match(contactDetail, /aria-label={`Mark plan as done: \${planLabel}`}/);
  assert.match(contactDetail, /aria-label={`Delete plan: \${planLabel}`}/);

  const settings = readFileSync(join(projectRoot, 'app', 'settings', 'page.tsx'), 'utf8');
  for (const controlId of ['restore-file', 'restore-confirmation']) {
    assert.match(settings, new RegExp(`htmlFor="${controlId}"`));
    assert.match(settings, new RegExp(`id="${controlId}"`));
  }
});

test('destructive confirmation keeps recovery guidance and keyboard containment', () => {
  const dialog = readFileSync(join(projectRoot, 'components', 'ui', 'confirm-dialog.tsx'), 'utf8');
  assert.match(dialog, /role="alertdialog"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /aria-labelledby=/);
  assert.match(dialog, /aria-describedby=/);
  assert.match(dialog, /cancelRef\.current\?\.focus\(\)/);
  assert.match(dialog, /event\.key === 'Escape'/);
  assert.match(dialog, /event\.key !== 'Tab'/);
  assert.match(dialog, /safetyNote: string/);
  assert.match(dialog, /safetyTone: 'recovery' \| 'irreversible'/);

  let confirmationCount = 0;
  for (const file of listTsxFiles(join(projectRoot, 'app'))) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\b(?:window\.)?confirm\s*\(/, file);
    for (const usage of source.match(/<ConfirmDialog[\s\S]*?\/>/g) || []) {
      confirmationCount++;
      assert.match(usage, /\bsafetyNote=/, file);
      assert.match(usage, /\bsafetyTone=/, file);
    }
  }
  assert.ok(confirmationCount > 0);
});
