import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  contactFormDraftHasChanges,
  CONTACT_DRAFT_TTL_MS,
  EMPTY_CONTACT_FORM_DRAFT,
  contactDraftStorageKey,
  parseSessionContactDraft,
  serializeSessionContactDraft,
} from '../lib/contact-form-draft.ts';

test('contact draft comparison detects exact field changes without serializing embedded photos', () => {
  const pristine = { ...EMPTY_CONTACT_FORM_DRAFT };
  assert.equal(contactFormDraftHasChanges(pristine), false);
  assert.equal(contactFormDraftHasChanges({ ...pristine, name: 'Ada Lovelace' }), true);

  const withPhoto = { ...pristine, photo_url: 'data:image/png;base64,private-photo' };
  assert.equal(contactFormDraftHasChanges({ ...withPhoto }, withPhoto), false);
  assert.equal(contactFormDraftHasChanges({ ...withPhoto, notes: 'New context' }, withPhoto), true);
});

test('opt-in session drafts omit photos, expire, and reject malformed fields', () => {
  assert.notEqual(contactDraftStorageKey('google:user-a'), contactDraftStorageKey('google:user-b'));
  const now = Date.parse('2026-10-02T12:00:00Z');
  const raw = serializeSessionContactDraft({
    ...EMPTY_CONTACT_FORM_DRAFT,
    name: 'Ada Lovelace',
    notes: 'Private note',
    photo_url: 'data:image/png;base64,private-photo',
  }, ['context', 'photo'], now);
  assert.ok(raw);
  assert.doesNotMatch(raw, /private-photo/);
  assert.deepEqual(parseSessionContactDraft(raw, now), {
    form: { ...EMPTY_CONTACT_FORM_DRAFT, name: 'Ada Lovelace', notes: 'Private note' },
    openSections: ['photo', 'context'],
    photoExcluded: true,
    savedAt: now,
  });
  assert.equal(parseSessionContactDraft(raw, now + CONTACT_DRAFT_TTL_MS + 1), null);
  assert.equal(parseSessionContactDraft(raw?.replace('Ada Lovelace', 'Ada'), now)?.form.name, 'Ada');
  assert.equal(parseSessionContactDraft(JSON.stringify({ ...JSON.parse(raw), form: { ...JSON.parse(raw).form, name: 7 } }), now), null);
  assert.equal(parseSessionContactDraft('{broken', now), null);
});

test('long contact forms protect dirty drafts from accidental navigation', () => {
  const guard = readFileSync('components/ui/unsaved-changes-guard.tsx', 'utf8');
  const coordinator = readFileSync('components/navigation-guard-provider.tsx', 'utf8');
  const providers = readFileSync('components/providers.tsx', 'utf8');
  const creator = readFileSync('app/contacts/new/page.tsx', 'utf8');
  const editor = readFileSync('app/contacts/[id]/edit/page.tsx', 'utf8');

  assert.match(guard, /addEventListener\('beforeunload'/);
  assert.match(guard, /document\.addEventListener\('click', handleLinkClick, true\)/);
  assert.match(guard, /closest<HTMLAnchorElement>\('a\[href\]'\)/);
  assert.match(guard, /event\.preventDefault\(\)/);
  assert.match(guard, /<ConfirmDialog/);
  assert.match(guard, /Discard unsaved changes\?/);
  assert.match(guard, /useHistoryNavigationBlocker/);
  assert.match(guard, /onDiscard\(\)/);
  assert.doesNotMatch(guard, /window\.confirm/);

  assert.match(coordinator, /__bondsHistoryPoint/);
  assert.match(coordinator, /window\.history\.go\(-delta\)/);
  assert.match(coordinator, /allowNextTraversal = true/);
  assert.match(coordinator, /if \(allowNextTraversal\)/);
  assert.match(coordinator, /new Map<number, HistoryBlocker>/);
  assert.match(coordinator, /blockersRef\.current\.get\(currentPoint\)/);
  assert.match(coordinator, /event\.stopImmediatePropagation\(\)/);
  assert.match(providers, /<NavigationGuardProvider>/);

  assert.match(creator, /contactFormDraftHasChanges\(form\)/);
  assert.match(creator, /<UnsavedChangesGuard active=\{hasUnsavedChanges\} onDiscard=\{discardDraft\}/);
  assert.match(editor, /setInitialForm\(loadedForm\)/);
  assert.match(editor, /contactFormDraftHasChanges\(form, initialForm\)/);
  assert.match(editor, /onDiscard=\{discardDraft\}/);
  assert.match(editor, /discardAndReload\(\)/);
  assert.doesNotMatch(`${creator}\n${editor}`, /JSON\.stringify\(form\)/);
});
