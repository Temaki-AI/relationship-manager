'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { AlertTriangle, ArrowLeft, ExternalLink, RefreshCw, Save } from 'lucide-react';
import { MentionInput } from '@/components/ui/mention-input';
import { TagInput } from '@/components/ui/tag-input';
import { createResponseError, getResponseErrorMessage, parseCustomFields, parseGiftIdeas, parseTags, getSocialLinks, ResponseError } from '@/lib/utils';
import { useToast } from '@/components/ui/toast';
import { PhotoInput } from '@/components/ui/photo-input';
import { LoadError } from '@/components/ui/load-error';
import {
  UnsavedChangesGuard,
  type UnsavedChangesGuardHandle,
} from '@/components/ui/unsaved-changes-guard';
import {
  contactFormDraftHasChanges,
  type ContactFormDraft,
} from '@/lib/contact-form-draft';

export default function EditContact() {
  const params = useParams();
  const id = params.id as string;
  const router = useRouter();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [loadFailure, setLoadFailure] = useState<{ status: number | null; message: string } | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [editRevision, setEditRevision] = useState('');
  const [hasConflict, setHasConflict] = useState(false);
  const [originalCustomFields, setOriginalCustomFields] = useState<Record<string, unknown>>({});
  const [initialForm, setInitialForm] = useState<ContactFormDraft | null>(null);
  const unsavedChangesGuardRef = useRef<UnsavedChangesGuardHandle>(null);
  const focusedSetupField = useRef<string | null>(null);
  const [form, setForm] = useState({
    name: '',
    nickname: '',
    email: '',
    phone: '',
    photo_url: '',
    birthday: '',
    birthday_reminder_days: 7,
    how_we_met: '',
    tags: '',
    notes: '',
    gift_ideas: '',
    contact_frequency: 14,
    company: '',
    job_title: '',
    location: '',
    linkedin: '',
    twitter: '',
    instagram: '',
    facebook: '',
    website: '',
  });

  useEffect(() => {
    const controller = new AbortController();
    async function fetchContact() {
      setLoading(true);
      try {
        const res = await fetch(`/api/contacts/${id}`, { cache: 'no-store', signal: controller.signal });
        if (!res.ok) {
          throw await createResponseError(res, 'Failed to fetch contact');
        }
        const data = await res.json();
        const contact = data.contact;
        if (!contact) throw new Error('The contact response was incomplete');
        setEditRevision(contact.edit_revision || '');
        setHasConflict(false);
        const customFields = parseCustomFields(contact.custom_fields);
        setOriginalCustomFields(customFields);
        const social = getSocialLinks(contact.custom_fields);
        const linkedInMeta = customFields.linkedin && typeof customFields.linkedin === 'object'
          ? customFields.linkedin as Record<string, string>
          : null;
        const loadedForm = {
          name: contact.name || '',
          nickname: contact.nickname || '',
          email: contact.email || '',
          phone: contact.phone || '',
          photo_url: contact.photo_url || '',
          birthday: contact.birthday || '',
          birthday_reminder_days: contact.birthday_reminder_days ?? 7,
          how_we_met: contact.how_we_met || '',
          tags: parseTags(contact.tags).join(', '),
          notes: contact.notes || '',
          gift_ideas: parseGiftIdeas(contact.gift_ideas).join('\n'),
          contact_frequency: contact.contact_frequency || 14,
          company: linkedInMeta?.company || (customFields.company as string) || '',
          job_title: linkedInMeta?.headline || (customFields.job_title as string) || '',
          location: linkedInMeta?.location || (customFields.location as string) || '',
          linkedin: social.linkedin || linkedInMeta?.profile_url || '',
          twitter: social.twitter || '',
          instagram: social.instagram || '',
          facebook: social.facebook || '',
          website: social.website || '',
        };
        setForm(loadedForm);
        setInitialForm(loadedForm);
        setLoadFailure(null);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.error('Failed to fetch contact:', error);
        setLoadFailure({
          status: error instanceof ResponseError ? error.status : null,
          message: error instanceof Error ? error.message : 'Failed to fetch contact',
        });
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    fetchContact();
    return () => controller.abort();
  }, [id, reloadToken]);

  useEffect(() => {
    if (loading || !initialForm) return;
    const focus = new URLSearchParams(window.location.search).get('focus');
    if (focus !== 'birthday' && focus !== 'cadence') return;
    const key = `${id}:${focus}`;
    if (focusedSetupField.current === key) return;
    const field = document.getElementById(focus === 'birthday' ? 'birthday' : 'frequency');
    if (!field) return;
    focusedSetupField.current = key;
    field.scrollIntoView({ behavior: 'auto', block: 'center' });
    field.focus({ preventScroll: true });
  }, [id, initialForm, loading]);

  const hasUnsavedChanges = initialForm !== null
    && contactFormDraftHasChanges(form, initialForm);

  function discardDraft() {
    if (initialForm) setForm({ ...initialForm });
    setHasConflict(false);
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

      const custom_fields: Record<string, unknown> = { ...originalCustomFields };
      if (Object.keys(social).length > 0) custom_fields.social = social;
      else delete custom_fields.social;

      for (const [field, value] of [
        ['company', form.company],
        ['job_title', form.job_title],
        ['location', form.location],
      ]) {
        if (value) custom_fields[field] = value;
        else delete custom_fields[field];
      }

      if (custom_fields.linkedin && typeof custom_fields.linkedin === 'object') {
        custom_fields.linkedin = {
          ...(custom_fields.linkedin as Record<string, unknown>),
          profile_url: form.linkedin || null,
          company: form.company || null,
          headline: form.job_title || null,
          location: form.location || null,
        };
      }

      const res = await fetch(`/api/contacts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
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
          expected_edit_revision: editRevision,
        }),
      });

      if (!res.ok) {
        if (res.status === 409) setHasConflict(true);
        toast({ message: await getResponseErrorMessage(res, 'Failed to save changes'), variant: 'error' });
        return;
      }

      toast({ message: 'Contact saved' });
      router.push(`/contacts/${id}`);
    } catch (error) {
      console.error('Failed to update contact:', error);
      toast({ message: 'Failed to save changes', variant: 'error' });
    } finally {
      setSubmitting(false);
    }
  }

  if (loading && !loadFailure) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="skeleton h-5 w-16" />
        <div className="skeleton h-9 w-48" />
        <div className="skeleton h-96 rounded-xl" />
      </div>
    );
  }

  if (loadFailure?.status === 404) {
    return (
      <div className="mx-auto max-w-2xl py-12 text-center">
        <h1 className="text-xl font-semibold">Contact not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">This contact may have been deleted or the link may be incorrect.</p>
        <Link href="/contacts" className={buttonVariants({ variant: 'outline', className: 'mt-4' })}>
          Back to contacts
        </Link>
      </div>
    );
  }

  if (loadFailure) {
    return (
      <div className="mx-auto max-w-2xl py-8">
        <LoadError
          title="We couldn't open the editor"
          message={`${loadFailure.message}. No blank form has been opened and your contact has not been changed.`}
          retrying={loading}
          onRetry={() => setReloadToken((value) => value + 1)}
          backHref={`/contacts/${id}`}
          backLabel="Back to contact"
        />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <UnsavedChangesGuard
        ref={unsavedChangesGuardRef}
        active={hasUnsavedChanges}
        onDiscard={discardDraft}
      />
      <div className="animate-fade-in">
        <Link href={`/contacts/${id}`} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="w-4 h-4" />
          Back
        </Link>
      </div>

      <div className="animate-fade-in-up">
        <h1 className="text-2xl sm:text-3xl font-bold">Edit contact ✏️</h1>
      </div>

      <form onSubmit={handleSubmit}>
        <Card className="animate-fade-in-up border-border/70 shadow-card">
          <CardContent className="pt-6 space-y-6">
            {hasConflict && (
              <section
                role="alert"
                aria-labelledby="edit-conflict-heading"
                className="rounded-xl border border-amber-300 bg-warning-soft p-4 text-amber-950"
              >
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
                  <div className="space-y-3">
                    <div>
                      <h2 id="edit-conflict-heading" className="font-semibold">This contact changed somewhere else</h2>
                      <p className="mt-1 text-sm text-amber-900">
                        Your draft is still here and was not overwritten. Open the latest version in a new tab to compare, or discard this draft and reload.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Link
                        href={`/contacts/${id}`}
                        target="_blank"
                        rel="noreferrer"
                        className={buttonVariants({ variant: 'outline', size: 'sm' })}
                      >
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                        Open latest
                      </Link>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => unsavedChangesGuardRef.current?.discardAndReload()}
                      >
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                        Discard draft and reload
                      </Button>
                    </div>
                  </div>
                </div>
              </section>
            )}
            <div className="space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">The basics</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="name">Name</Label>
                  <Input id="name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="mt-1" />
                </div>
                <div>
                  <Label htmlFor="nickname">Nickname</Label>
                  <Input id="nickname" value={form.nickname} onChange={(e) => setForm({ ...form, nickname: e.target.value })} placeholder="What they go by" className="mt-1" />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="mt-1" />
                </div>
                <div>
                  <Label htmlFor="phone">Phone</Label>
                  <Input id="phone" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="mt-1" />
                </div>
              </div>
              <PhotoInput
                id="photo"
                name={form.name}
                value={form.photo_url}
                onChange={(photoUrl) => setForm({ ...form, photo_url: photoUrl })}
              />
            </div>

            <div className="border-t border-border/50" />

            <div className="space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Professional</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="company">Company</Label>
                  <Input id="company" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} className="mt-1" />
                </div>
                <div>
                  <Label htmlFor="job_title">Job title</Label>
                  <Input id="job_title" value={form.job_title} onChange={(e) => setForm({ ...form, job_title: e.target.value })} className="mt-1" />
                </div>
              </div>
              <div>
                <Label htmlFor="location">Location</Label>
                <Input id="location" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} className="mt-1" />
              </div>
            </div>

            <div className="border-t border-border/50" />

            <div className="space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Social links</h3>
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
            </div>

            <div className="border-t border-border/50" />

            <div className="space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Birthday reminder</h3>
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
            </div>

            <div className="border-t border-border/50" />

            <div className="space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Context</h3>
              <div>
                <Label htmlFor="how_we_met">How did you meet?</Label>
                <Input id="how_we_met" value={form.how_we_met} onChange={(e) => setForm({ ...form, how_we_met: e.target.value })} className="mt-1" />
              </div>
              <div>
                <Label htmlFor="tags">Tags</Label>
                <TagInput id="tags" value={form.tags} onChange={(val) => setForm({ ...form, tags: val })} className="mt-1" />
                <p className="text-[11px] text-muted-foreground mt-1">Separate with commas</p>
              </div>
              <div>
                <Label htmlFor="notes">Notes</Label>
                <MentionInput id="notes" value={form.notes} onChange={(val) => setForm({ ...form, notes: val })} rows={3} className="mt-1" />
              </div>
              <div>
                <Label htmlFor="gift_ideas">Gift ideas</Label>
                <Textarea id="gift_ideas" value={form.gift_ideas} onChange={(e) => setForm({ ...form, gift_ideas: e.target.value })} rows={3} className="mt-1" />
                <p className="text-[11px] text-muted-foreground mt-1">One per line</p>
              </div>
            </div>

            <div className="border-t border-border/50" />

            <div className="space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Staying in touch</h3>
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
            </div>

            <div className="border-t border-border/50" />

            <div className="flex gap-3 pt-1">
              <Button type="submit" disabled={submitting} className="shadow-sm">
                <Save className="w-4 h-4 mr-2" />
                {submitting ? 'Saving...' : 'Save changes'}
              </Button>
              <Link href={`/contacts/${id}`} className={buttonVariants({ variant: 'ghost' })}>
                Cancel
              </Link>
            </div>
          </CardContent>
        </Card>
      </form>
    </div>
  );
}
