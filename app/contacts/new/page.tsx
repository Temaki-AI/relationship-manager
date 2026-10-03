'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { ArrowLeft, CalendarDays, Camera, Check, Clock3, Gift, IdCard, MapPin, ShieldCheck, Sparkles, UserPlus, Users } from 'lucide-react';
import { MentionInput } from '@/components/ui/mention-input';
import { TagInput } from '@/components/ui/tag-input';
import { createIdempotencyKey, getResponseErrorMessage } from '@/lib/utils';
import { useToast } from '@/components/ui/toast';
import { PhotoInput } from '@/components/ui/photo-input';
import { UnsavedChangesGuard } from '@/components/ui/unsaved-changes-guard';
import { cloudAuthClient } from '@/lib/cloud/auth-client';
import {
  clearLegacyContactSessionDraft,
  contactDraftStorageKey,
  contactFormDraftHasChanges,
  EMPTY_CONTACT_FORM_DRAFT,
  parseSessionContactDraft,
  serializeSessionContactDraft,
  type OptionalContactSection,
} from '@/lib/contact-form-draft';

const googleAuthEnabled = process.env.NEXT_PUBLIC_AUTH_MODE === 'google';

const OPTIONAL_SECTION_CHOICES: Array<{ id: OptionalContactSection; label: string; icon: typeof IdCard }> = [
  { id: 'identity', label: 'Nickname', icon: IdCard },
  { id: 'photo', label: 'Photo', icon: Camera },
  { id: 'professional', label: 'Work & place', icon: MapPin },
  { id: 'social', label: 'Social links', icon: Users },
  { id: 'birthday', label: 'Birthday', icon: CalendarDays },
  { id: 'context', label: 'Story & gifts', icon: Gift },
  { id: 'rhythm', label: 'Check-in rhythm', icon: Clock3 },
];

function persistSessionDraft(key: string, form: typeof EMPTY_CONTACT_FORM_DRAFT, sections: OptionalContactSection[]): 'too-large' | 'unavailable' | null {
  const serialized = serializeSessionContactDraft(form, sections);
  if (!serialized) return 'too-large';
  try {
    sessionStorage.setItem(key, serialized);
    return null;
  } catch {
    return 'unavailable';
  }
}

export default function NewContact() {
  const router = useRouter();
  const { toast } = useToast();
  const createAttempt = useRef<{ payload: string; key: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [form, setForm] = useState(() => ({ ...EMPTY_CONTACT_FORM_DRAFT }));
  const [openSections, setOpenSections] = useState<OptionalContactSection[]>([]);
  const [draftStorageKey, setDraftStorageKey] = useState<string | null>(null);
  const [draftReady, setDraftReady] = useState(false);
  const [draftRecoveryEnabled, setDraftRecoveryEnabled] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const [restoredPhotoExcluded, setRestoredPhotoExcluded] = useState(false);
  const hasUnsavedChanges = contactFormDraftHasChanges(form);

  useEffect(() => {
    let cancelled = false;
    async function initializeDraft() {
      clearLegacyContactSessionDraft();
      let accountId: string | null = null;
      try {
        if (googleAuthEnabled) {
          const { data } = await cloudAuthClient.getSession();
          if (typeof data?.user?.id === 'string' && data.user.id) accountId = `google:${data.user.id}`;
        } else {
          const response = await fetch('/api/auth/session', { cache: 'no-store' });
          const data = await response.json() as { authenticated?: boolean; mode?: string };
          if (response.ok && (data.authenticated || data.mode === 'disabled')) {
            accountId = data.mode === 'disabled' ? 'local:disabled' : 'local:password';
          }
        }
      } catch {
        // Creation remains available even if draft recovery cannot be verified.
      }
      if (cancelled) return;
      if (accountId) {
        const key = contactDraftStorageKey(accountId);
        setDraftStorageKey(key);
        try {
          const raw = sessionStorage.getItem(key);
          const restored = parseSessionContactDraft(raw);
          if (restored) {
            setForm(restored.form);
            setOpenSections(restored.openSections);
            setDraftRecoveryEnabled(true);
            setDraftRestored(true);
            setRestoredPhotoExcluded(restored.photoExcluded);
          } else if (raw) {
            sessionStorage.removeItem(key);
          }
        } catch {
          // The form remains usable when tab storage is disabled.
        }
      }
      setDraftReady(true);
    }
    void initializeDraft();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!draftReady) return;
    if (!draftStorageKey) return;
    if (!draftRecoveryEnabled || !hasUnsavedChanges) {
      try { sessionStorage.removeItem(draftStorageKey); } catch { /* Storage may be disabled. */ }
      return;
    }
    const error = persistSessionDraft(draftStorageKey, form, openSections);
    if (error) {
      toast({
        message: error === 'too-large'
          ? 'This draft is too large to keep in this tab. Shorten the notes or save the contact.'
          : 'This browser could not keep the draft in this tab. The form is still here.',
        variant: 'error',
      });
      setDraftRecoveryEnabled(false);
    }
  }, [draftReady, draftRecoveryEnabled, draftStorageKey, form, openSections, hasUnsavedChanges, toast]);

  function saveSessionDraft(): boolean {
    if (!draftStorageKey) return false;
    const error = persistSessionDraft(draftStorageKey, form, openSections);
    if (error) {
      toast({ message: error === 'too-large' ? 'This draft is too large to keep.' : 'This browser could not keep the draft.', variant: 'error' });
      setDraftRecoveryEnabled(false);
      return false;
    }
    return true;
  }

  function discardDraft() {
    createAttempt.current = null;
    try { if (draftStorageKey) sessionStorage.removeItem(draftStorageKey); } catch { /* Storage may be disabled. */ }
    setDraftRecoveryEnabled(false);
    setDraftRestored(false);
    setRestoredPhotoExcluded(false);
    setOpenSections([]);
    setForm({ ...EMPTY_CONTACT_FORM_DRAFT });
  }

  function revealSection(section: OptionalContactSection) {
    setOpenSections((current) => current.includes(section) ? current : [...current, section]);
  }

  async function handleEnrich() {
    if (!form.email) {
      toast({ message: 'Enter an email address first', variant: 'info' });
      return;
    }

    setEnriching(true);
    try {
      const res = await fetch('/api/enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.email }),
      });

      if (!res.ok) {
        toast({ message: await getResponseErrorMessage(res, 'Failed to enrich contact data'), variant: 'error' });
        return;
      }

      const result = await res.json();

      if (result.success && result.data) {
        const enriched = result.data;

        // Auto-fill fields that are empty
        setForm((prev) => ({
          ...prev,
          company: enriched.company || prev.company,
          notes: enriched.suggestedNotes
            ? prev.notes
              ? `${prev.notes}\n\n${enriched.suggestedNotes}`
              : enriched.suggestedNotes
            : prev.notes,
        }));
        if (enriched.company) revealSection('professional');

        toast(
          result.found
            ? { message: `Filled company from ${enriched.companyDomain}`, variant: 'success' }
            : { message: 'No company domain found for this email', variant: 'info' }
        );
      }
    } catch (error) {
      console.error('Enrichment failed:', error);
      toast({ message: 'Failed to enrich contact data', variant: 'error' });
    } finally {
      setEnriching(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);

    try {
      const tagsArray = form.tags.split(',').map((t) => t.trim()).filter((t) => t);
      const giftIdeasArray = form.gift_ideas.split('\n').map((g) => g.trim()).filter((g) => g);

      const social: Record<string, string> = {};
      if (form.linkedin) social.linkedin = form.linkedin;
      if (form.twitter) social.twitter = form.twitter;
      if (form.instagram) social.instagram = form.instagram;
      if (form.facebook) social.facebook = form.facebook;
      if (form.website) social.website = form.website;

      const custom_fields: Record<string, unknown> = {};
      if (Object.keys(social).length > 0) custom_fields.social = social;
      if (form.company) custom_fields.company = form.company;
      if (form.job_title) custom_fields.job_title = form.job_title;
      if (form.location) custom_fields.location = form.location;
      const payload = JSON.stringify({
        name: form.name,
        nickname: form.nickname,
        email: form.email,
        phone: form.phone,
        photo_url: form.photo_url || null,
        birthday: form.birthday || null,
        birthday_reminder_days: form.birthday_reminder_days,
        how_we_met: form.how_we_met,
        tags: tagsArray,
        notes: form.notes,
        gift_ideas: giftIdeasArray,
        contact_frequency: form.contact_frequency,
        custom_fields,
      });
      const attempt = createAttempt.current || { payload, key: createIdempotencyKey() };
      const reconcilingEarlierSave = attempt.payload !== payload;
      createAttempt.current = attempt;

      const res = await fetch('/api/contacts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': attempt.key,
        },
        body: attempt.payload,
      });

      if (!res.ok) {
        if (res.status !== 409) createAttempt.current = null;
        toast({ message: await getResponseErrorMessage(res, 'Failed to create contact'), variant: 'error' });
        return;
      }

      const { contact } = await res.json() as { contact?: { id?: number } };
      if (!Number.isSafeInteger(contact?.id) || !contact?.id) {
        throw new Error('The saved contact response was incomplete. Retry to confirm the earlier request.');
      }
      discardDraft();
      if (reconcilingEarlierSave) {
        toast({ message: 'The earlier save was confirmed. Changes made afterward were not applied; add them from the profile.', variant: 'info' });
      }
      router.push(`/contacts/${contact.id}`);
    } catch (error) {
      console.error('Failed to create contact:', error);
      toast({
        message: 'We could not confirm whether the contact was saved. Retry without changing the form; the same request will be reused safely.',
        variant: 'error',
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <UnsavedChangesGuard active={hasUnsavedChanges} onDiscard={discardDraft} onKeep={draftRecoveryEnabled ? saveSessionDraft : undefined} />
      <div className="animate-fade-in">
        <Link href="/contacts" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="w-4 h-4" />
          Back
        </Link>
      </div>

      <div className="animate-fade-in-up">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-primary">A person, not a form</p>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Add someone new</h1>
        <p className="mt-1 text-sm text-muted-foreground">Start with what you know. Only a name is required.</p>
      </div>

      {draftRestored && (
        <div role="status" className="flex flex-col gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950 sm:flex-row sm:items-center sm:justify-between">
          <p>Draft restored from this browser tab.{restoredPhotoExcluded ? ' Add the photo again if you still want it.' : ''}</p>
          <Button type="button" variant="outline" size="sm" onClick={discardDraft}>Discard draft</Button>
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <Card className="animate-fade-in-up border-0 shadow-sm">
          <CardContent className="space-y-6 p-4 sm:p-6">
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-bold">The essentials</h2>
                <p className="mt-1 text-xs text-muted-foreground">You can fill in everything else later from their profile.</p>
              </div>
              <div>
                <Label htmlFor="name">Name</Label>
                <Input id="name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Full name" className="mt-1 h-11" />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="their@email.com" className="mt-1 h-11" />
                </div>
                <div>
                  <Label htmlFor="phone">Phone</Label>
                  <Input id="phone" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+1-555-0123" className="mt-1 h-11" />
                </div>
              </div>
              <div>
                <Label htmlFor="notes">A note to remember</Label>
                <MentionInput id="notes" value={form.notes} onChange={(val) => setForm({ ...form, notes: val })} placeholder="What would you like to remember?" rows={2} className="mt-1" />
              </div>
            </div>

            <div className="sticky bottom-20 z-20 -mx-4 flex items-center gap-3 border-y border-rose-100 bg-white/95 px-4 py-3 shadow-[0_-10px_30px_-20px_rgba(72,35,35,0.45)] backdrop-blur sm:static sm:mx-0 sm:flex-wrap sm:border-x-0 sm:border-b-0 sm:border-t sm:bg-transparent sm:px-0 sm:pt-5 sm:shadow-none">
              <Button type="submit" disabled={submitting} className="h-11 shadow-sm">
                <UserPlus className="h-4 w-4" aria-hidden="true" />
                {submitting ? 'Adding...' : 'Add contact'}
              </Button>
              <Link href="/contacts" className={buttonVariants({ variant: 'ghost', className: 'h-11' })}>Cancel</Link>
              <span className="hidden text-xs text-muted-foreground sm:inline">More details can wait.</span>
            </div>

            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-dashed bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground">
              <input
                type="checkbox"
                checked={draftRecoveryEnabled}
                disabled={!draftReady || !draftStorageKey}
                onChange={(event) => setDraftRecoveryEnabled(event.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
              />
              <span><strong className="text-foreground">Keep a draft in this tab</strong><br />{draftReady && !draftStorageKey
                ? 'Draft recovery is unavailable until your account can be verified. The form still works.'
                : 'Optional and tied to your account. Recoverable in this browser tab for up to 24 hours; expired drafts are cleared when you return. Photos are never stored. Turn this off, discard, or save to remove it.'}</span>
            </label>

            <div className="border-t border-border/50 pt-5">
              <div className="mb-3">
                <h2 className="text-base font-bold">Add more detail</h2>
                <p className="mt-1 text-xs text-muted-foreground">Choose only what is useful right now.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {OPTIONAL_SECTION_CHOICES.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    disabled={openSections.includes(id)}
                    onClick={() => revealSection(id)}
                    className={`inline-flex min-h-10 items-center gap-2 rounded-full border px-3 text-xs font-semibold transition ${openSections.includes(id) ? 'border-primary/30 bg-primary/10 text-primary' : 'bg-white text-muted-foreground hover:border-primary/30 hover:text-foreground'}`}
                  >
                    {openSections.includes(id) ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {openSections.includes('identity') && (
              <section className="space-y-4 border-t pt-5">
                <h3 className="text-sm font-semibold">What they go by</h3>
                <div>
                  <Label htmlFor="nickname">Nickname</Label>
                  <Input id="nickname" value={form.nickname} onChange={(e) => setForm({ ...form, nickname: e.target.value })} placeholder="What they go by" className="mt-1" />
                </div>
              </section>
            )}

            {openSections.includes('photo') && (
              <section className="space-y-4 border-t pt-5">
                <h3 className="text-sm font-semibold">Photo</h3>
                <PhotoInput
                  id="photo"
                  name={form.name}
                  value={form.photo_url}
                  onChange={(photoUrl) => setForm({ ...form, photo_url: photoUrl })}
                />
              </section>
            )}

            {openSections.includes('professional') && (
            <section className="space-y-4 border-t pt-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">Work & place</h3>
                <Button type="button" variant="outline" size="sm" onClick={handleEnrich} disabled={!form.email || enriching}>
                  <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                  {enriching ? 'Checking...' : 'Fill from email domain'}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">This uses the email domain locally. No external lookup.</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="company">Company</Label>
                  <Input id="company" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} placeholder="Where they work" className="mt-1" />
                </div>
                <div>
                  <Label htmlFor="job_title">Job title</Label>
                  <Input id="job_title" value={form.job_title} onChange={(e) => setForm({ ...form, job_title: e.target.value })} placeholder="Their role" className="mt-1" />
                </div>
              </div>
              <div>
                <Label htmlFor="location">Location</Label>
                <Input id="location" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="City, Country" className="mt-1" />
              </div>
            </section>
            )}

            {openSections.includes('social') && (
            <section className="space-y-4 border-t pt-5">
              <h3 className="text-sm font-semibold">Social links</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="linkedin">LinkedIn</Label>
                  <Input id="linkedin" type="url" value={form.linkedin} onChange={(e) => setForm({ ...form, linkedin: e.target.value })} placeholder="https://linkedin.com/in/..." className="mt-1" />
                </div>
                <div>
                  <Label htmlFor="twitter">Twitter / X</Label>
                  <Input id="twitter" type="url" value={form.twitter} onChange={(e) => setForm({ ...form, twitter: e.target.value })} placeholder="https://x.com/..." className="mt-1" />
                </div>
                <div>
                  <Label htmlFor="instagram">Instagram</Label>
                  <Input id="instagram" type="url" value={form.instagram} onChange={(e) => setForm({ ...form, instagram: e.target.value })} placeholder="https://instagram.com/..." className="mt-1" />
                </div>
                <div>
                  <Label htmlFor="facebook">Facebook</Label>
                  <Input id="facebook" type="url" value={form.facebook} onChange={(e) => setForm({ ...form, facebook: e.target.value })} placeholder="https://facebook.com/..." className="mt-1" />
                </div>
              </div>
              <div>
                <Label htmlFor="website">Website</Label>
                <Input id="website" type="url" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="https://..." className="mt-1" />
              </div>
            </section>
            )}

            {openSections.includes('birthday') && (
            <section className="space-y-4 border-t pt-5">
              <h3 className="text-sm font-semibold">Birthday reminder</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="birthday">Birthday</Label>
                  <Input id="birthday" type="date" value={form.birthday} onChange={(e) => setForm({ ...form, birthday: e.target.value })} className="mt-1" />
                </div>
                <div>
                  <Label htmlFor="birthday_reminder_days">Alert me</Label>
                  <div className="flex items-center gap-2 mt-1">
                    <Input
                      id="birthday_reminder_days"
                      type="number"
                      min="0"
                      max="365"
                      value={form.birthday_reminder_days}
                      onChange={(e) => {
                        const parsed = parseInt(e.target.value, 10);
                        setForm({
                          ...form,
                          birthday_reminder_days: Number.isNaN(parsed)
                            ? 7
                            : Math.min(365, Math.max(0, parsed)),
                        });
                      }}
                      className="w-20"
                    />
                    <span className="text-sm text-muted-foreground">days before</span>
                  </div>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">Use 0 for an alert on the birthday itself. Browser alerts must be enabled.</p>
            </section>
            )}

            {openSections.includes('context') && (
            <section className="space-y-4 border-t pt-5">
              <h3 className="text-sm font-semibold">Story & gifts</h3>
              <div>
                <Label htmlFor="how_we_met">How did you meet?</Label>
                <Input id="how_we_met" value={form.how_we_met} onChange={(e) => setForm({ ...form, how_we_met: e.target.value })} placeholder="Running club, conference, work..." className="mt-1" />
              </div>
              <div>
                <Label htmlFor="tags">Tags</Label>
                <TagInput id="tags" value={form.tags} onChange={(val) => setForm({ ...form, tags: val })} placeholder="friend, work, tennis" className="mt-1" />
                <p className="text-[11px] text-muted-foreground mt-1">Separate with commas</p>
              </div>
              <div>
                <Label htmlFor="gift_ideas">Gift ideas</Label>
                <Textarea id="gift_ideas" value={form.gift_ideas} onChange={(e) => setForm({ ...form, gift_ideas: e.target.value })} placeholder="Running shoes&#10;A good book&#10;Coffee subscription" rows={3} className="mt-1" />
                <p className="text-[11px] text-muted-foreground mt-1">One per line</p>
              </div>
            </section>
            )}

            {openSections.includes('rhythm') && (
            <section className="space-y-4 border-t pt-5">
              <h3 className="text-sm font-semibold">Staying in touch</h3>
              <div>
                <Label htmlFor="frequency">Check in every</Label>
                <div className="flex items-center gap-2 mt-1">
                  <Input
                    id="frequency"
                    type="number"
                    min="1"
                    max="3650"
                    value={form.contact_frequency}
                    onChange={(e) => {
                      const parsed = parseInt(e.target.value, 10);
                      setForm({
                        ...form,
                        contact_frequency: Number.isNaN(parsed) ? 14 : Math.min(3650, Math.max(1, parsed)),
                      });
                    }}
                    className="w-20"
                  />
                  <span className="text-sm text-muted-foreground">days</span>
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">Used to highlight relationships that may be ready for a check-in.</p>
              </div>
            </section>
            )}

            {openSections.length > 0 && (
              <div className="flex flex-wrap items-center gap-3 border-t pt-5">
                <Button type="submit" disabled={submitting} className="h-11 shadow-sm">
                  <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                  {submitting ? 'Adding...' : 'Save contact with details'}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </form>
    </div>
  );
}
