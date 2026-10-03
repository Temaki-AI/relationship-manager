import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('primary consumer areas define distinct server-rendered document titles', () => {
  const titles: Record<string, string> = {
    login: 'Sign in',
    contacts: 'Contacts',
    groups: 'Groups',
    'smart-lists': 'Smart Lists',
    reminders: 'Reminders',
    calendar: 'Calendar',
    integrations: 'Data connections',
    settings: 'Data & recovery',
  };

  for (const [area, title] of Object.entries(titles)) {
    const layout = readFileSync(`app/${area}/layout.tsx`, 'utf8');
    assert.match(layout, new RegExp(`title: '${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
    assert.doesNotMatch(layout, /['"]use client['"]/);
  }

  const rootLayout = readFileSync('app/layout.tsx', 'utf8');
  assert.match(rootLayout, /template: "%s \| Everclose CRM"/);
});
