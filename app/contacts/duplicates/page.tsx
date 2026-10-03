'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Cake,
  CheckCircle2,
  ExternalLink,
  GitMerge,
  History,
  Mail,
  Phone,
  RefreshCw,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { findDuplicateContactGroups, type DuplicateContact, type DuplicateContactGroup, type DuplicateIdentity, type DuplicateSignalKind } from '@/lib/contact-merge';
import { paginateDuplicateGroups, selectDuplicateBatch } from '@/lib/duplicate-review';
import { formatRelativeDate, getResponseErrorMessage, parseTags } from '@/lib/utils';

type DuplicateResponse = {
  revision?: number;
  groups: DuplicateContactGroup[];
  groupCount: number;
  contactCount: number;
  truncatedGroupCount: number;
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
};

type CloudScanPage = {
  contacts: DuplicateIdentity[];
  nextCursor: number | null;
  revision: number;
  total: number;
};

const cloudMode = process.env.NEXT_PUBLIC_AUTH_MODE === 'google';

function reasonLabel(kind: DuplicateSignalKind): string {
  if (kind === 'email') return 'Same email';
  if (kind === 'phone') return 'Same phone';
  return 'Same name and birthday';
}

function historyCount(contact: DuplicateContact): number {
  return (contact.interaction_count || 0)
    + (contact.reminder_count || 0)
    + (contact.fact_count || 0)
    + (contact.plan_count || 0);
}

function ContactChoice({
  contact,
  selected,
  recommended,
  groupName,
  onSelect,
}: {
  contact: DuplicateContact;
  selected: boolean;
  recommended: boolean;
  groupName: string;
  onSelect: () => void;
}) {
  const tags = parseTags(contact.tags);
  const history = historyCount(contact);

  return (
    <div
      className={`relative rounded-2xl border p-4 transition-all ${
        selected
          ? 'border-primary bg-primary/5 shadow-sm ring-1 ring-primary/20'
          : 'border-border/70 bg-white hover:border-primary/30'
      }`}
    >
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="radio"
          name={groupName}
          aria-label={`Keep ${contact.name} as the primary profile`}
          checked={selected}
          onChange={onSelect}
          className="mt-1 h-4 w-4 border-border text-primary focus:ring-primary"
        />
        <Avatar contact={contact} size="sm" className="h-11 w-11 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold text-foreground">{contact.name}</p>
            {recommended && (
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                Recommended
              </span>
            )}
          </div>

          <div className="mt-2 space-y-1 text-xs text-muted-foreground">
            {contact.email && (
              <p className="flex min-w-0 items-center gap-1.5">
                <Mail className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate">{contact.email}</span>
              </p>
            )}
            {contact.phone && (
              <p className="flex items-center gap-1.5">
                <Phone className="h-3.5 w-3.5 flex-shrink-0" />
                <span>{contact.phone}</span>
              </p>
            )}
            {contact.birthday && (
              <p className="flex items-center gap-1.5">
                <Cake className="h-3.5 w-3.5 flex-shrink-0" />
                <span>{contact.birthday}</span>
              </p>
            )}
          </div>

          <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
            <span className="rounded-full bg-muted px-2 py-1">
              {history} history {history === 1 ? 'item' : 'items'}
            </span>
            <span className="rounded-full bg-muted px-2 py-1">
              {contact.group_count || 0} {(contact.group_count || 0) === 1 ? 'group' : 'groups'}
            </span>
            <span className="rounded-full bg-muted px-2 py-1">
              Last touched {formatRelativeDate(contact.last_contacted).toLowerCase()}
            </span>
          </div>

          {tags.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1">
              {tags.slice(0, 4).map((tag) => (
                <span key={tag} className="rounded-full bg-secondary px-2 py-0.5 text-[10px] text-secondary-foreground">
                  {tag}
                </span>
              ))}
            </div>
          )}

        </div>
      </label>
      <Link
        href={`/contacts/${contact.id}`}
        aria-label={`Inspect ${contact.name}`}
        className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
      >
        Inspect profile
        <ExternalLink className="h-3 w-3" />
      </Link>
    </div>
  );
}

export default function DuplicateContactsPage() {
  const [data, setData] = useState<DuplicateResponse | null>(null);
  const [selectedPrimary, setSelectedPrimary] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mergingGroup, setMergingGroup] = useState<string | null>(null);
  const [mergeTarget, setMergeTarget] = useState<DuplicateContactGroup | null>(null);
  const [scanProgress, setScanProgress] = useState<{ scanned: number; total: number } | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const mergeAttemptRef = useRef<{ signature: string; key: string } | null>(null);
  const { toast } = useToast();

  const applyDuplicateData = useCallback((nextData: DuplicateResponse) => {
    setData(nextData);
    setSelectedPrimary((current) => Object.fromEntries(
      nextData.groups.map((group) => [
        group.id,
        group.contacts.some((contact) => contact.id === current[group.id])
          ? current[group.id]
          : group.recommendedPrimaryId,
      ])
    ));
  }, []);

  const loadDuplicates = useCallback(async (page = 1) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError(null);
    setScanProgress(null);
    try {
      if (cloudMode) {
        const contacts: DuplicateIdentity[] = [];
        let cursor: number | null = null;
        let revision: number | null = null;
        do {
          const params = new URLSearchParams();
          if (cursor !== null) {
            params.set('after', String(cursor));
            params.set('revision', String(revision));
          }
          const response = await fetch(`/api/contacts/duplicates${params.size ? `?${params}` : ''}`, {
            cache: 'no-store', signal: controller.signal,
          });
          if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Failed to review duplicates'));
          const chunk = await response.json() as CloudScanPage;
          if (chunk.nextCursor !== null && chunk.nextCursor <= (cursor || 0)) {
            throw new Error('Duplicate scan stopped making progress. Refresh and try again.');
          }
          contacts.push(...chunk.contacts);
          revision = chunk.revision;
          cursor = chunk.nextCursor;
          if (!controller.signal.aborted) setScanProgress({ scanned: contacts.length, total: chunk.total });
        } while (cursor !== null);
        if (controller.signal.aborted) return;
        const summary = paginateDuplicateGroups(findDuplicateContactGroups(contacts), { page, pageSize: 10 });
        const batchIds = summary.pageGroups.flatMap(selectDuplicateBatch);
        const details = new Map<number, DuplicateContact>();
        if (batchIds.length) {
          const response = await fetch(`/api/contacts/duplicates?ids=${batchIds.join(',')}&revision=${revision}`, {
            cache: 'no-store', signal: controller.signal,
          });
          if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Failed to load duplicate details'));
          const result = await response.json() as { contacts: DuplicateContact[]; revision: number };
          if (result.revision !== revision || result.contacts.length !== batchIds.length) {
            throw new Error('Your people changed during the scan. Refresh to review current matches.');
          }
          for (const contact of result.contacts) details.set(contact.id, contact);
        }
        if (controller.signal.aborted) return;
        const groups = summary.pageGroups.map((group) => {
          const selected = selectDuplicateBatch(group);
          const hydrated = selected.map((id) => details.get(id));
          if (hydrated.some((contact) => !contact)) {
            throw new Error('Duplicate details are incomplete. Refresh the review.');
          }
          return { ...group, contacts: hydrated as DuplicateContact[],
            totalContacts: group.contacts.length, hasMoreContacts: group.contacts.length > selected.length };
        });
        applyDuplicateData({ ...summary, revision: revision!, groups });
        return;
      }
      const response = await fetch(`/api/contacts/duplicates?page=${page}&pageSize=10`, {
        cache: 'no-store', signal: controller.signal,
      });
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Failed to review duplicates'));
      const nextData = await response.json() as DuplicateResponse;
      if (!controller.signal.aborted) applyDuplicateData(nextData);
    } finally {
      if (requestRef.current === controller) {
        setScanProgress(null);
        setLoading(false);
      }
    }
  }, [applyDuplicateData]);

  useEffect(() => {
    loadDuplicates()
      .catch((loadError) => {
        if (loadError instanceof Error && loadError.name === 'AbortError') return;
        setError(loadError instanceof Error ? loadError.message : 'Failed to review duplicates');
      });
    return () => {
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [loadDuplicates]);

  async function mergeGroup(group: DuplicateContactGroup) {
    const primaryId = selectedPrimary[group.id] || group.recommendedPrimaryId;
    const primary = group.contacts.find((contact) => contact.id === primaryId);
    const duplicateIds = group.contacts.filter((contact) => contact.id !== primaryId).map((contact) => contact.id);
    if (!primary || duplicateIds.length === 0) return;
    const payload = { primaryId, duplicateIds, ...(cloudMode ? { expectedRevision: data?.revision } : {}) };
    const signature = JSON.stringify(payload);
    const requestKey = cloudMode
      ? mergeAttemptRef.current?.signature === signature
        ? mergeAttemptRef.current.key
        : crypto.randomUUID()
      : null;
    if (requestKey) mergeAttemptRef.current = { signature, key: requestKey };
    setMergingGroup(group.id);
    try {
      const response = await fetch('/api/contacts/duplicates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(requestKey ? { 'Idempotency-Key': requestKey } : {}) },
        body: signature,
      });
      if (!response.ok) {
        throw new Error(await getResponseErrorMessage(response, 'Failed to merge contacts'));
      }
      const result = await response.json() as { remaining?: DuplicateResponse; replayed?: boolean };
      mergeAttemptRef.current = null;
      setMergeTarget(null);
      toast({
        message: result.replayed
          ? `This merge into ${primary.name} had already completed. Review your current recovery points in Settings.`
          : `${duplicateIds.length} ${duplicateIds.length === 1 ? 'profile' : 'profiles'} merged into ${primary.name}. A recovery point was saved.`,
        variant: 'success',
      });
      if (cloudMode) {
        try { await loadDuplicates(data?.pagination.page || 1); }
        catch (refreshError) {
          if (refreshError instanceof Error && refreshError.name === 'AbortError') return;
          setError(refreshError instanceof Error ? `Merge succeeded, but review could not refresh: ${refreshError.message}` : 'Merge succeeded, but review could not refresh.');
        }
      } else if (result.remaining) applyDuplicateData(result.remaining);
    } catch (mergeError) {
      toast({
        message: (mergeError instanceof TypeError || mergeError instanceof SyntaxError) && cloudMode
          ? 'Could not confirm the merge response. Retry this same merge safely.'
          : mergeError instanceof Error ? mergeError.message : 'Failed to merge contacts',
        variant: 'error',
      });
    } finally {
      setMergingGroup(null);
    }
  }

  const mergeTargetPrimaryId = mergeTarget
    ? selectedPrimary[mergeTarget.id] || mergeTarget.recommendedPrimaryId
    : null;
  const mergeTargetPrimary = mergeTarget?.contacts.find((contact) => contact.id === mergeTargetPrimaryId);
  const mergeTargetDuplicateCount = mergeTarget
    ? mergeTarget.contacts.filter((contact) => contact.id !== mergeTargetPrimaryId).length
    : 0;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="animate-fade-in">
        <Link href="/contacts" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          Your people
        </Link>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <GitMerge className="h-6 w-6 text-primary" />
              <h1 className="text-2xl font-bold sm:text-3xl">Clean up duplicates</h1>
            </div>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              Review possible matches and bring their history, reminders, and notes into one profile.
            </p>
          </div>
          {data && data.groupCount > 0 && (
            <span className="w-fit rounded-full bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700">
              {data.groupCount} possible {data.groupCount === 1 ? 'match' : 'matches'}
            </span>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={mergeTarget !== null && Boolean(mergeTargetPrimary)}
        title={`Merge ${mergeTargetDuplicateCount + 1} profiles?`}
        description={mergeTarget && mergeTargetPrimary
          ? `Keep ${mergeTargetPrimary.name} and move fields, history, reminders, plans, and groups from ${mergeTargetDuplicateCount} other ${mergeTargetDuplicateCount === 1 ? 'profile' : 'profiles'} into it.${mergeTarget.hasMoreContacts ? ` This is one safe batch from a ${mergeTarget.totalContacts}-profile match.` : ''}`
          : ''}
        safetyNote="The merge is transactional and a verified recovery point will be saved first."
        safetyTone="recovery"
        confirmLabel="Merge profiles"
        pendingLabel="Saving recovery point..."
        pending={mergingGroup !== null}
        onCancel={() => setMergeTarget(null)}
        onConfirm={() => {
          if (mergeTarget) void mergeGroup(mergeTarget);
        }}
      />

      <Card className="border-0 bg-gradient-to-br from-rose-50 via-white to-amber-50 shadow-sm">
        <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-white p-2.5 text-emerald-600 shadow-sm">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <p className="font-semibold">Safe by design</p>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                Exact contact matches only. A verified recovery point is saved before merging.
              </p>
            </div>
          </div>
          <Link href="/settings" className="text-xs font-medium text-primary hover:underline">
            View recovery points
          </Link>
        </CardContent>
      </Card>

      {loading ? (
        <div className="space-y-4">
          {scanProgress && <p className="text-sm text-muted-foreground" role="status">
            Checking {scanProgress.scanned.toLocaleString()} of {scanProgress.total.toLocaleString()} people for possible matches...
          </p>}
          {[1, 2].map((item) => <div key={item} className="skeleton h-80 rounded-2xl" />)}
        </div>
      ) : error ? (
        <Card className="border-0 shadow-sm">
          <CardContent className="py-14 text-center">
            <p className="font-semibold">Duplicate review could not load</p>
            <p className="mt-1 text-sm text-muted-foreground">{error}</p>
            <Button
              variant="outline"
              className="mt-4"
              onClick={() => {
                loadDuplicates().catch((loadError) => {
                  if (loadError instanceof Error && loadError.name === 'AbortError') return;
                  setError(loadError instanceof Error ? loadError.message : 'Failed to review duplicates');
                });
              }}
            >
              <RefreshCw className="h-4 w-4" />
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : !data || data.groups.length === 0 ? (
        <Card className="border-0 shadow-sm animate-scale-in">
          <CardContent className="py-16 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">
              <CheckCircle2 className="h-7 w-7" />
            </div>
            <h2 className="mt-4 text-lg font-semibold">Your people are tidy</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              No contacts share a verified email, phone number, or name and birthday.
            </p>
            <Link href="/contacts" className={buttonVariants({ className: 'mt-5' })}>
              Back to contacts
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-5 stagger-children">
          {data.groups.map((group, index) => {
            const primaryId = selectedPrimary[group.id] || group.recommendedPrimaryId;
            const primary = group.contacts.find((contact) => contact.id === primaryId);
            const duplicateCount = group.contacts.length - 1;
            const totalContacts = group.totalContacts || group.contacts.length;
            const remainingProfiles = Math.max(0, totalContacts - group.contacts.length);
            const displayIndex = (data.pagination.page - 1) * data.pagination.pageSize + index + 1;
            return (
              <Card
                key={group.id}
                role="region"
                aria-labelledby={`duplicate-group-${group.id}`}
                className="overflow-hidden border-0 shadow-sm"
              >
                <div className="h-1 bg-gradient-to-r from-amber-400 via-rose-400 to-primary" />
                <CardHeader className="pb-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <CardTitle id={`duplicate-group-${group.id}`} className="flex items-center gap-2 text-lg">
                        <UsersRound className="h-5 w-5 text-primary" />
                        Possible match {displayIndex}
                      </CardTitle>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {group.reasons.map((reason) => (
                          <span key={`${reason.kind}:${reason.value}`} className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-800">
                            {reasonLabel(reason.kind)}: {reason.value}
                          </span>
                        ))}
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {group.hasMoreContacts
                        ? `Showing a safe batch of ${group.contacts.length} from ${totalContacts} matching profiles.`
                        : 'Choose the profile name and core details to keep.'}
                    </p>
                  </div>
                </CardHeader>
                <CardContent className="space-y-5">
                  <fieldset>
                    <legend className="sr-only">
                      Choose the primary profile for possible match {displayIndex}
                    </legend>
                    <div className="grid gap-3 md:grid-cols-2">
                      {group.contacts.map((candidate) => (
                        <ContactChoice
                          key={candidate.id}
                          contact={candidate}
                          selected={candidate.id === primaryId}
                          recommended={candidate.id === group.recommendedPrimaryId}
                          groupName={`duplicate-primary-${group.id}`}
                          onSelect={() => setSelectedPrimary((current) => ({ ...current, [group.id]: candidate.id }))}
                        />
                      ))}
                    </div>
                  </fieldset>

                  <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-muted/25 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-start gap-2.5">
                      <History className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" />
                      <p className="text-sm text-muted-foreground">
                        Keep <span className="font-semibold text-foreground">{primary?.name}</span>. All fields, history, reminders, plans, and groups from the other {duplicateCount === 1 ? 'profile' : 'profiles'} in this batch will move here.
                        {remainingProfiles > 0 && ` ${remainingProfiles} matching profiles will remain for the next safe batch.`}
                      </p>
                    </div>
                    <Button
                      className="h-11 flex-shrink-0 sm:h-9"
                      disabled={mergingGroup !== null}
                      onClick={() => setMergeTarget(group)}
                    >
                      {mergingGroup === group.id ? <RefreshCw className="h-4 w-4 animate-spin" /> : <GitMerge className="h-4 w-4" />}
                      {mergingGroup === group.id
                        ? 'Merging...'
                        : group.hasMoreContacts
                          ? `Merge batch of ${duplicateCount + 1}`
                          : `Merge ${duplicateCount + 1} profiles`}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
          {data.pagination.totalPages > 1 && (
            <div className="flex flex-col gap-3 border-t border-border/60 pt-5 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground" aria-live="polite">
                Page {data.pagination.page} of {data.pagination.totalPages} · {data.groupCount} duplicate groups
              </p>
              <div className="grid grid-cols-2 gap-2 sm:flex">
                <Button
                  variant="outline"
                  className="h-11 sm:h-9"
                  disabled={data.pagination.page <= 1 || mergingGroup !== null}
                  onClick={() => {
                    loadDuplicates(data.pagination.page - 1)
                      .catch((loadError) => {
                        if (loadError instanceof Error && loadError.name === 'AbortError') return;
                        setError(loadError instanceof Error ? loadError.message : 'Failed to review duplicates');
                      });
                  }}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  className="h-11 sm:h-9"
                  disabled={data.pagination.page >= data.pagination.totalPages || mergingGroup !== null}
                  onClick={() => {
                    loadDuplicates(data.pagination.page + 1)
                      .catch((loadError) => {
                        if (loadError instanceof Error && loadError.name === 'AbortError') return;
                        setError(loadError instanceof Error ? loadError.message : 'Failed to review duplicates');
                      });
                  }}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
