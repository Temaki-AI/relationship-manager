'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { CheckSquare, ChevronLeft, ChevronRight, Contact as ContactIcon, Download, FileText, GitMerge, LayoutGrid, List, MoreHorizontal, RefreshCw, Search, ShieldCheck, Sparkles, Square, Tag, Trash2, Upload, UserPlus, X } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import type { DirectoryContact } from '@/lib/contact-directory-projection';
import { Avatar } from '@/components/ui/avatar';
import { createIdempotencyKey, formatRelativeDate, getResponseErrorMessage, parseTags } from '@/lib/utils';
import { describeCheckInRhythm } from '@/lib/check-in-rhythm';
import { useToast } from '@/components/ui/toast';
import { LoadError } from '@/components/ui/load-error';
import { buildPhoneContactsVCard, getPhoneContactsManager } from '@/lib/phone-contact-import';
import { readDirectoryUrl, updateDirectoryUrl, type DirectoryUrlState, type DirectoryView } from '@/lib/contact-directory-url';

type BulkAction = 'delete' | 'add_tag' | 'remove_tag';
type ContactPagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};
type TagSummary = { tag: string; contactCount: number };
const cloudImports = process.env.NEXT_PUBLIC_AUTH_MODE === 'google';

const BULK_ACTION_OPTIONS: Array<{ value: BulkAction; label: string }> = [
  { value: 'delete', label: 'Delete contacts' },
  { value: 'add_tag', label: 'Add tag' },
  { value: 'remove_tag', label: 'Remove tag' },
];

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {[1, 2, 3, 4, 5, 6].map((i) => (
        <div key={i} className="skeleton h-44 rounded-xl" />
      ))}
    </div>
  );
}

function SkeletonList() {
  return (
    <div className="space-y-3">
      {[1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="skeleton h-24 rounded-xl" />
      ))}
    </div>
  );
}

function getBulkSuccessMessage(operation: BulkAction, affected: number) {
  if (operation === 'delete') {
    return `Deleted ${affected} ${affected === 1 ? 'contact' : 'contacts'}`;
  }

  if (operation === 'add_tag') {
    return `Updated tags on ${affected} ${affected === 1 ? 'contact' : 'contacts'}`;
  }

  if (operation === 'remove_tag') {
    return `Removed the tag from ${affected} ${affected === 1 ? 'contact' : 'contacts'}`;
  }

  return `Removed the tag from ${affected} ${affected === 1 ? 'contact' : 'contacts'}`;
}

function getContactSubtitle(contact: DirectoryContact): string | null {
  if (contact.company && contact.location) return `${contact.company} · ${contact.location}`;
  if (contact.company) return contact.company;
  if (contact.location) return contact.location;
  return contact.email || contact.phone || null;
}

export default function ContactsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { captureMoment, search: searchQuery, tag: selectedTag, page, view } = readDirectoryUrl(new URLSearchParams(searchParams.toString()));
  const contactHref = (contactId: number) => `/contacts/${contactId}${captureMoment ? '?capture=moment' : ''}`;
  const [contacts, setContacts] = useState<DirectoryContact[]>([]);
  const [tagSummaries, setTagSummaries] = useState<TagSummary[]>([]);
  const [tagTotal, setTagTotal] = useState(0);
  const [pagination, setPagination] = useState<ContactPagination>({
    page: 1,
    pageSize: 50,
    total: 0,
    totalPages: 1,
  });
  const [overallTotal, setOverallTotal] = useState(0);
  const [search, setSearch] = useState(searchQuery);
  const [selectedContactIds, setSelectedContactIds] = useState<number[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [bulkAction, setBulkAction] = useState<BulkAction>('delete');
  const [bulkValue, setBulkValue] = useState('');
  const [defaultViewMode, setDefaultViewMode] = useState<DirectoryView>('list');
  const viewMode = view || defaultViewMode;
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [uploadAttempt, setUploadAttempt] = useState<{ file: File; format: 'csv' | 'vcard'; key: string } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [phonePickerSupported, setPhonePickerSupported] = useState(false);
  const [showTransferPanel, setShowTransferPanel] = useState(false);
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false);
  const manageMenuRef = useRef<HTMLDetailsElement>(null);
  const searchTimerRef = useRef<number | null>(null);
  const pendingSearchRef = useRef<string | null>(null);
  const searchEditInProgressRef = useRef(false);
  const { toast } = useToast();

  const writeDirectoryUrl = useCallback((patch: Partial<Pick<DirectoryUrlState, 'search' | 'tag' | 'page' | 'view'>>, mode: 'push' | 'replace' = 'push') => {
    const next = updateDirectoryUrl(window.location.href, patch);
    if (`${window.location.pathname}${window.location.search}${window.location.hash}` === next) return false;
    if (mode === 'replace') window.history.replaceState(null, '', next);
    else window.history.pushState(null, '', next);
    return true;
  }, []);

  function navigateDirectory(patch: Partial<Pick<DirectoryUrlState, 'tag' | 'page' | 'view'>>) {
    if (searchTimerRef.current !== null) window.clearTimeout(searchTimerRef.current);
    searchTimerRef.current = null;
    searchEditInProgressRef.current = false;
    pendingSearchRef.current = search.trim();
    if (!writeDirectoryUrl({ ...patch, search })) pendingSearchRef.current = null;
  }

  const refreshData = useCallback(async (targetPage = page, signal?: AbortSignal) => {
    const params = new URLSearchParams({ page: String(targetPage), pageSize: '50' });
    if (searchQuery.trim()) params.set('search', searchQuery.trim());
    if (selectedTag) params.set('tag', selectedTag);
    const contactsRes = await fetch(`/api/contacts?${params}`, {
      cache: 'no-store',
      signal,
    });

    if (!contactsRes.ok) {
      throw new Error(await getResponseErrorMessage(contactsRes, 'Failed to fetch contacts'));
    }

    const contactsData = await contactsRes.json();
    const nextContacts = Array.isArray(contactsData.contacts) ? contactsData.contacts : [];
    setContacts(nextContacts);
    setOverallTotal(Number(contactsData.overallTotal) || 0);
    if (contactsData.pagination) {
      setPagination(contactsData.pagination as ContactPagination);
      if (contactsData.pagination.page !== targetPage && !signal?.aborted) {
        const current = readDirectoryUrl(new URLSearchParams(window.location.search));
        if (current.page === targetPage && current.search === searchQuery && current.tag === selectedTag) {
          writeDirectoryUrl({ page: contactsData.pagination.page }, 'replace');
        }
      }
    }
  }, [page, searchQuery, selectedTag, writeDirectoryUrl]);

  const refreshTags = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch('/api/contacts?view=tags&pageSize=100', {
      cache: 'no-store',
      signal,
    });
    if (!response.ok) {
      throw new Error(await getResponseErrorMessage(response, 'Failed to fetch contact groups'));
    }
    const data = await response.json();
    setTagSummaries(Array.isArray(data.tags) ? data.tags : []);
    setTagTotal(Number(data.pagination?.total) || 0);
  }, []);

  useEffect(() => {
    const stored = window.localStorage.getItem('contacts-view-mode');
    if (stored === 'list' || stored === 'grid') {
      setDefaultViewMode(stored);
    }
  }, []);

  useEffect(() => {
    setPhonePickerSupported(Boolean(getPhoneContactsManager(window.navigator)));
  }, []);

  useEffect(() => {
    if (pendingSearchRef.current !== null) {
      if (pendingSearchRef.current !== searchQuery) return;
      pendingSearchRef.current = null;
    }
    setSearch(searchQuery);
  }, [searchQuery]);

  useEffect(() => {
    const restoreSearch = () => {
      if (searchTimerRef.current !== null) window.clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
      pendingSearchRef.current = null;
      searchEditInProgressRef.current = false;
      setSearch(readDirectoryUrl(new URLSearchParams(window.location.search)).search);
    };
    window.addEventListener('popstate', restoreSearch);
    return () => {
      window.removeEventListener('popstate', restoreSearch);
      if (searchTimerRef.current !== null) window.clearTimeout(searchTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setRefreshing(true);
    refreshData(page, controller.signal)
      .then(() => setLoadError(null))
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.error('Failed to fetch contacts page data:', error);
        setLoadError(error instanceof Error ? error.message : 'Failed to fetch contacts');
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
    });
    return () => controller.abort();
  }, [page, refreshData, reloadToken]);

  useEffect(() => {
    const controller = new AbortController();
    refreshTags(controller.signal).catch((error) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      toast({ message: error instanceof Error ? error.message : 'Failed to fetch contact groups', variant: 'error' });
    });
    return () => controller.abort();
  }, [refreshTags, toast]);

  useEffect(() => {
    setSelectedContactIds((previous) =>
      previous.filter((contactId) => contacts.some((contact) => contact.id === contactId))
    );
  }, [contacts]);

  const allTags = tagSummaries.map((summary) => summary.tag);
  const filteredContacts = contacts;

  const selectedIdSet = useMemo(() => new Set(selectedContactIds), [selectedContactIds]);
  const filteredContactIds = filteredContacts.map((contact) => contact.id);
  const areAllFilteredSelected = filteredContactIds.length > 0 && filteredContactIds.every((id) => selectedIdSet.has(id));
  const selectedCount = selectedContactIds.length;
  const bulkActionNeedsTag = bulkAction === 'add_tag' || bulkAction === 'remove_tag';
  const canApplyBulkAction =
    selectedCount > 0 &&
    !bulkSubmitting &&
    !refreshing &&
    (!bulkActionNeedsTag || bulkValue.trim().length > 0);

  function toggleContactSelection(contactId: number) {
    setSelectedContactIds((previous) =>
      previous.includes(contactId)
        ? previous.filter((id) => id !== contactId)
        : [...previous, contactId]
    );
  }

  function toggleSelectAllFiltered() {
    setSelectedContactIds((previous) => {
      if (areAllFilteredSelected) {
        return previous.filter((id) => !filteredContactIds.includes(id));
      }

      return Array.from(new Set([...previous, ...filteredContactIds]));
    });
  }

  async function handleContactImport(file: File, format: 'csv' | 'vcard') {
    setImporting(true);
    setUploadError(null);
    try {
      const attempt = cloudImports
        ? uploadAttempt?.file === file ? uploadAttempt : { file, format, key: createIdempotencyKey() }
        : null;
      if (attempt) setUploadAttempt(attempt);
      const formData = new FormData();
      formData.append('file', file);
      const endpoint = format === 'vcard' ? '/api/import/vcard' : '/api/import/csv';
      const response = await fetch(endpoint, { method: 'POST', body: formData, headers: attempt ? { 'Idempotency-Key': attempt.key } : undefined });
      const data = await response.json();
      if (!response.ok) {
        if (cloudImports) setUploadError(data.error || 'The upload could not be confirmed. Retry this file or check your saved reports.');
        toast({ message: data.error || 'Import failed', variant: 'error' });
        return;
      }

      if (cloudImports) {
        if (!data.job?.id) throw new Error('No saved import report was returned.');
        setUploadAttempt(null);
        router.push(`/contacts/imports/${encodeURIComponent(data.job.id)}`);
        return;
      }

      const imported = Number(data.imported) || 0;
      const duplicates = Number(data.skippedDuplicates ?? data.duplicates) || 0;
      const invalid = Number(data.skippedInvalid) || Math.max(0, (Number(data.skipped) || 0) - duplicates);
      const detail = [
        `${imported} imported`,
        duplicates > 0 ? `${duplicates} duplicate${duplicates === 1 ? '' : 's'} skipped` : '',
        invalid > 0 ? `${invalid} invalid skipped` : '',
      ].filter(Boolean).join(', ');

      toast({
        message: detail,
        variant: imported > 0 ? 'success' : 'info',
      });
      if (imported > 0) setShowTransferPanel(false);

      if (page === 1) {
        try {
          await refreshData(1);
        } catch (refreshError) {
          console.error('Import committed, but the contact directory could not refresh:', refreshError);
          setLoadError(`Import completed (${detail}), but the contact directory could not be refreshed`);
          return;
        }
      } else {
        navigateDirectory({ page: 1 });
      }

      try {
        await refreshTags();
      } catch (refreshError) {
        console.error('Import committed, but contact groups could not refresh:', refreshError);
        toast({ message: 'Import completed, but contact groups could not be refreshed yet', variant: 'info' });
      }
    } catch (error) {
      if (cloudImports) setUploadError('The upload response was interrupted. Retry the same file safely, or check saved reports. No contacts are added before you confirm the preview.');
      console.error(`Failed to import ${format}:`, error);
      toast({ message: `Failed to import ${format === 'vcard' ? 'vCard' : 'CSV'} contacts`, variant: 'error' });
    } finally {
      setImporting(false);
    }
  }

  async function handlePhoneContactImport() {
    const contactsManager = getPhoneContactsManager(window.navigator);
    if (!contactsManager) {
      document.getElementById('vcard-import')?.click();
      return;
    }

    setImporting(true);
    try {
      const availableProperties = await contactsManager.getProperties();
      const requestedProperties = ['name', 'email', 'tel'].filter((property) =>
        availableProperties.includes(property)
      );
      const selectedContacts = await contactsManager.select(requestedProperties, { multiple: true });
      const vCard = buildPhoneContactsVCard(selectedContacts);

      if (!vCard) {
        toast({ message: 'No contact details were selected', variant: 'info' });
        return;
      }

      const file = new File([vCard], `phone-contacts-${Date.now()}.vcf`, { type: 'text/vcard' });
      await handleContactImport(file, 'vcard');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      console.error('Failed to import contacts from the phone picker:', error);
      toast({ message: 'Could not open your phone contacts', variant: 'error' });
    } finally {
      setImporting(false);
    }
  }

  async function handleBulkAction() {
    if (!canApplyBulkAction) {
      return;
    }

    setBulkSubmitting(true);

    try {
      const payload: Record<string, unknown> = {
        operation: bulkAction,
        contactIds: selectedContactIds,
      };

      if (bulkActionNeedsTag) {
        payload.tag = bulkValue.trim();
      }

      const res = await fetch('/api/contacts/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        toast({ message: await getResponseErrorMessage(res, 'Failed to apply bulk action'), variant: 'error' });
        return;
      }

      const data = await res.json();
      const successMessage = bulkAction === 'delete'
        ? `${getBulkSuccessMessage(bulkAction, Number(data.affected) || 0)}. A recovery point was saved in Settings.`
        : getBulkSuccessMessage(bulkAction, Number(data.affected) || 0);
      setSelectedContactIds([]);
      setSelectionMode(false);
      setBulkValue('');
      if (bulkAction === 'delete') setBulkDeleteConfirmOpen(false);
      toast({ message: successMessage });

      try {
        await refreshData();
      } catch (refreshError) {
        console.error('Bulk action committed, but the contact directory could not refresh:', refreshError);
        setLoadError(`${successMessage} The change was saved, but the contact directory could not be refreshed`);
        return;
      }

      try {
        await refreshTags();
      } catch (refreshError) {
        console.error('Bulk action committed, but contact groups could not refresh:', refreshError);
        toast({ message: 'Contacts were updated, but contact groups could not be refreshed yet', variant: 'info' });
      }
    } catch (error) {
      console.error('Failed to apply bulk contact action:', error);
      toast({ message: 'Failed to apply bulk action', variant: 'error' });
    } finally {
      setBulkSubmitting(false);
    }
  }

  if (loading && !loadError) {
    return (
      <div className="space-y-6">
        <div className="flex justify-between items-center">
          <div className="skeleton h-9 w-40" />
          <div className="skeleton h-9 w-32" />
        </div>
        {viewMode === 'list' ? <SkeletonList /> : <SkeletonGrid />}
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="space-y-6">
        <div className="flex flex-col gap-4 animate-fade-in sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold sm:text-3xl">Your people</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">Your contact directory is temporarily unavailable.</p>
          </div>
          <Link href="/contacts/new" className={buttonVariants({ size: 'sm' })}>
            <UserPlus className="h-3.5 w-3.5" />
            Add contact
          </Link>
        </div>
        <LoadError
          title="We couldn't load your contacts"
          message={`${loadError}. No empty or stale directory is being shown.`}
          retrying={refreshing}
          onRetry={() => setReloadToken((value) => value + 1)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="relative z-20 flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4 animate-fade-in">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold">Your people</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {overallTotal} {overallTotal === 1 ? 'contact' : 'contacts'}
            {(searchQuery || selectedTag) && (
              <> · {pagination.total} matching</>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/contacts/new" className={buttonVariants({ size: 'sm' })}>
            <UserPlus className="w-3.5 h-3.5 mr-1.5" />
            Add contact
          </Link>
          {selectionMode && <Button variant="secondary" size="sm" onClick={() => {
            setSelectionMode(false); setSelectedContactIds([]);
          }}>Done selecting</Button>}
          <details ref={manageMenuRef} className="relative">
            <summary className={buttonVariants({ variant: 'outline', size: 'sm', className: 'cursor-pointer list-none text-muted-foreground hover:bg-muted/60 hover:text-foreground [&::-webkit-details-marker]:hidden' })}>
              <MoreHorizontal className="h-4 w-4" />
              Manage
            </summary>
            <div className="absolute left-0 z-30 mt-2 w-60 rounded-xl border border-border bg-white p-2 shadow-lg sm:left-auto sm:right-0">
              <div className="mb-2 flex flex-col gap-2 border-b border-border pb-2">
          {contacts.length > 0 && !selectionMode && <Button
            type="button"
            variant={selectionMode ? 'secondary' : 'outline'}
            size="sm"
            aria-pressed={selectionMode}
            onClick={() => {
              setSelectionMode(true);
              setSelectedContactIds([]);
              manageMenuRef.current?.removeAttribute('open');
            }}
          >
            <CheckSquare className="h-3.5 w-3.5" />
            Select people
          </Button>}
          <div className="inline-flex rounded-lg border border-border/70 bg-white shadow-sm overflow-hidden">
            <button
              type="button"
              onClick={() => {
                window.localStorage.setItem('contacts-view-mode', 'grid');
                navigateDirectory({ view: 'grid' });
                manageMenuRef.current?.removeAttribute('open');
              }}
              aria-pressed={viewMode === 'grid'}
              className={`px-3 min-h-11 inline-flex items-center gap-2 text-sm ${viewMode === 'grid' ? 'bg-primary text-white' : 'text-muted-foreground hover:bg-muted/40'}`}
            >
              <LayoutGrid className="w-4 h-4" />
              Grid
            </button>
            <button
              type="button"
              onClick={() => {
                window.localStorage.setItem('contacts-view-mode', 'list');
                navigateDirectory({ view: 'list' });
                manageMenuRef.current?.removeAttribute('open');
              }}
              aria-pressed={viewMode === 'list'}
              className={`px-3 min-h-11 inline-flex items-center gap-2 text-sm ${viewMode === 'list' ? 'bg-primary text-white' : 'text-muted-foreground hover:bg-muted/40'}`}
            >
              <List className="w-4 h-4" />
              Compact list
            </button>
          </div>
              </div>
              <Link href="/contacts/duplicates" className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm text-foreground hover:bg-muted/50">
                <GitMerge className="h-4 w-4" />Clean up duplicates
              </Link>
              <button type="button" disabled={importing} onClick={() => { setShowTransferPanel((value) => !value); manageMenuRef.current?.removeAttribute('open'); }} className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm text-foreground hover:bg-muted/50 disabled:opacity-50">
                <Upload className="h-4 w-4" />{importing ? 'Importing...' : 'Transfer contacts'}
              </button>
              {cloudImports && <Link href="/contacts/imports" className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm text-foreground hover:bg-muted/50">
                <FileText className="h-4 w-4" />Import reports
              </Link>}
              {cloudImports && <Link href="/contacts/exports" className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm text-foreground hover:bg-muted/50">
                <Download className="h-4 w-4" />Contact exports
              </Link>}
            </div>
          </details>
        </div>
      </div>

      {captureMoment && (
        <div role="status" className="flex flex-col gap-3 rounded-xl border border-primary/20 bg-rose-50/70 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold">Who was this moment with?</p>
            <p className="mt-1 text-xs text-muted-foreground">Choose a person below, then capture what happened. Nothing is logged until you save it.</p>
          </div>
          <Link href="/contacts" className="text-sm font-medium text-primary hover:underline">Back to people</Link>
        </div>
      )}

      {cloudImports && uploadError && <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          <p>{uploadError}</p>
          {uploadAttempt && <Button className="mt-3" variant="outline" disabled={importing} onClick={() => void handleContactImport(uploadAttempt.file, uploadAttempt.format)}>{importing ? 'Uploading...' : `Retry ${uploadAttempt.file.name}`}</Button>}
      </div>}

      {(showTransferPanel || searchParams.get('import') === '1') && (
        <Card className="overflow-hidden border-0 shadow-sm animate-fade-in-up">
          <div className="h-1 bg-gradient-to-r from-rose-400 via-amber-400 to-emerald-400" />
          <CardContent className="grid gap-6 p-5 sm:p-6 lg:grid-cols-[1.2fr_1fr]">
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="rounded-xl bg-primary/10 p-2.5 text-primary">
                  <ContactIcon className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="font-semibold text-foreground">Bring your people with you</h2>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    {cloudImports ? 'Upload a vCard or CSV and preview every row before saving. You decide what to do with possible matches; existing contacts are never overwritten.' : 'Import a vCard from Apple, Google, or Outlook, or use a CSV spreadsheet. Everclose CRM skips matching emails and phone numbers automatically.'}
                  </p>
                </div>
              </div>

              {cloudImports && <p className="text-xs leading-relaxed text-muted-foreground">Files are uploaded to your cloud workspace for processing. Your original file and report are retained until you remove the report or erase the workspace. Up to 5,000 contacts and 10 MB per upload.</p>}

              <div className="grid gap-2 sm:grid-cols-2">
                <Button
                  variant="default"
                  className="justify-start"
                  disabled={importing}
                  onClick={handlePhoneContactImport}
                >
                  <ContactIcon className="h-4 w-4" />
                  {phonePickerSupported ? 'Choose from phone' : 'Import phone vCard'}
                </Button>
                <Button
                  variant="outline"
                  className="justify-start"
                  disabled={importing}
                  onClick={() => document.getElementById('csv-import')?.click()}
                >
                  <FileText className="h-4 w-4" />
                  Choose CSV
                </Button>
              </div>

              <p className="text-xs leading-relaxed text-muted-foreground">
                {phonePickerSupported
                  ? 'Select only the people you want to share. Everclose CRM requests names, email addresses, and phone numbers.'
                  : 'On iPhone, export or share the selected contacts as a vCard, save it to Files, then choose that file here.'}
              </p>

              <input
                id="vcard-import"
                type="file"
                accept=".vcf,.vcard,text/vcard,text/x-vcard"
                className="hidden"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (file) await handleContactImport(file, 'vcard');
                  event.target.value = '';
                }}
              />
              <input
                id="csv-import"
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (file) await handleContactImport(file, 'csv');
                  event.target.value = '';
                }}
              />

              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                Files go only to this Everclose CRM installation and are never sent to a third-party service.
              </div>
            </div>

            <div className="rounded-xl border border-border/60 bg-muted/30 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Take your data anywhere</p>
              <p className="mt-2 text-sm text-foreground">Download your contacts. For relationships, history, and reminders too, use a full backup in Settings.</p>
              <div className="mt-4 flex flex-col gap-2 sm:flex-row lg:flex-col xl:flex-row">
                {cloudImports ? <Link href="/contacts/exports" className={buttonVariants({ variant: 'secondary', size: 'sm', className: 'w-full flex-1' })}><Download className="h-3.5 w-3.5" />Prepare contact export</Link> : <>
                <a
                  href="/api/export/vcard"
                  download
                  className={buttonVariants({ variant: 'secondary', size: 'sm', className: 'w-full flex-1' })}
                >
                  <Download className="h-3.5 w-3.5" />
                  vCard
                </a>
                <a
                  href="/api/export/csv"
                  download
                  className={buttonVariants({ variant: 'outline', size: 'sm', className: 'w-full flex-1' })}
                >
                  <Download className="h-3.5 w-3.5" />
                  CSV
                </a>
                </>}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {contacts.length > 0 && selectionMode && (
        <Card className="border-0 shadow-sm animate-fade-in-up">
          <CardContent className="pt-5 pb-4 space-y-4">
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
              <div>
                <p className="font-semibold text-sm text-foreground">
                  {selectedCount > 0 ? `${selectedCount} selected` : 'Bulk actions'}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Select contacts on this page, then update tags or delete them together.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={toggleSelectAllFiltered} disabled={filteredContacts.length === 0}>
                  {areAllFilteredSelected ? <Square className="w-3.5 h-3.5 mr-1.5" /> : <CheckSquare className="w-3.5 h-3.5 mr-1.5" />}
                  {areAllFilteredSelected ? 'Clear page' : `Select page (${filteredContacts.length})`}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSelectedContactIds([])} disabled={selectedCount === 0}>
                  <X className="w-3.5 h-3.5 mr-1.5" />
                  Clear selection
                </Button>
              </div>
            </div>

            <div className="flex flex-col xl:flex-row gap-3">
              <select
                aria-label="Bulk action"
                value={bulkAction}
                onChange={(event) => {
                  setBulkAction(event.target.value as BulkAction);
                  setBulkValue('');
                }}
                className="flex h-10 w-full xl:w-56 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {BULK_ACTION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>

              {bulkActionNeedsTag && (
                <div className="relative flex-1">
                  <Tag className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    value={bulkValue}
                    onChange={(event) => setBulkValue(event.target.value)}
                    maxLength={100}
                    aria-label={bulkAction === 'add_tag' ? 'Tag to add' : 'Tag to remove'}
                    placeholder={bulkAction === 'add_tag' ? 'Tag to add...' : 'Tag to remove...'}
                    className="pl-9 h-10"
                  />
                </div>
              )}

              <Button
                onClick={() => {
                  if (bulkAction === 'delete') setBulkDeleteConfirmOpen(true);
                  else void handleBulkAction();
                }}
                disabled={!canApplyBulkAction}
                variant={bulkAction === 'delete' ? 'destructive' : 'default'}
                className="xl:min-w-36"
              >
                {bulkAction === 'delete' ? <Trash2 className="w-4 h-4 mr-1.5" /> : null}
                {bulkSubmitting ? 'Applying...' : 'Apply'}
              </Button>
            </div>

          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={bulkDeleteConfirmOpen}
        title={`Delete ${selectedCount} selected ${selectedCount === 1 ? 'contact' : 'contacts'}?`}
        description="This removes the selected people and their interactions, reminders, plans, facts, and group memberships from the active CRM."
        safetyNote="A verified recovery point will be saved first and can be restored from Settings."
        safetyTone="recovery"
        confirmLabel={selectedCount === 1 ? 'Delete contact' : `Delete ${selectedCount} contacts`}
        pendingLabel="Saving recovery point..."
        pending={bulkSubmitting}
        onCancel={() => setBulkDeleteConfirmOpen(false)}
        onConfirm={handleBulkAction}
      />

      <div className="space-y-3 animate-fade-in-up">
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4" />
          <Input
            type="text"
            aria-label="Search contacts"
            placeholder="Search people"
            value={search}
            onChange={(event) => {
              const next = event.target.value;
              setSearch(next);
              pendingSearchRef.current = next.trim();
              if (searchTimerRef.current !== null) window.clearTimeout(searchTimerRef.current);
              searchTimerRef.current = window.setTimeout(() => {
                searchTimerRef.current = null;
                if (writeDirectoryUrl({ search: next, page: 1 }, searchEditInProgressRef.current ? 'replace' : 'push')) {
                  searchEditInProgressRef.current = true;
                } else pendingSearchRef.current = null;
              }, 200);
            }}
            maxLength={200}
            className="h-11 rounded-xl border-border/60 bg-white pl-10 pr-10 focus:border-primary/40"
            aria-describedby="contact-results-status"
          />
          {refreshing && (
            <RefreshCw className="absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
        </div>
        <p id="contact-results-status" aria-live="polite" className="sr-only">
          {refreshing
            ? 'Updating contact results'
            : `${pagination.total} matching ${pagination.total === 1 ? 'contact' : 'contacts'}`}
        </p>

        {allTags.length > 0 && (
          <details open={selectedTag ? true : undefined} className="rounded-lg border border-border bg-white px-3">
            <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">{selectedTag ? `Group: ${selectedTag}` : 'Filter by group'}</summary>
            <div className="flex flex-wrap gap-1.5 pb-3">
            <button
              type="button"
              onClick={() => navigateDirectory({ tag: null, page: 1 })}
              aria-pressed={selectedTag === null}
              className={`min-h-11 px-3 py-2 text-sm font-medium rounded-full transition-all ${
                selectedTag === null
                  ? 'bg-primary text-white shadow-sm'
                  : 'bg-muted text-muted-foreground hover:bg-muted/70'
              }`}
            >
              All
            </button>
            {allTags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => navigateDirectory({ tag, page: 1 })}
                aria-pressed={selectedTag === tag}
                className={`min-h-11 px-3 py-2 text-sm font-medium rounded-full transition-all ${
                  selectedTag === tag
                    ? 'bg-primary text-white shadow-sm'
                    : 'bg-muted text-muted-foreground hover:bg-muted/70'
                }`}
              >
                {tag}
              </button>
            ))}
            {tagTotal > allTags.length && (
              <Link
                href="/groups"
                className="inline-flex min-h-11 items-center px-2 text-xs font-medium text-primary hover:underline"
              >
                View all {tagTotal} groups
              </Link>
            )}
            </div>
          </details>
        )}
      </div>

      {filteredContacts.length > 0 ? (
        viewMode === 'grid' ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 stagger-children">
            {filteredContacts.map((contact) => {
              const rhythm = describeCheckInRhythm(contact);
              const tags = parseTags(contact.tags);
              const isSelected = selectedIdSet.has(contact.id);

              return (
                <Card
                  key={contact.id}
                  className={`border-0 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md ${
                    isSelected ? 'ring-2 ring-primary/30 bg-primary/5' : ''
                  }`}
                >
                  <CardContent className="pt-5 pb-4 px-4 sm:px-5">
                    <div className={`mb-3 flex items-center ${selectionMode ? 'justify-between' : 'justify-end'}`}>
                      {selectionMode && <label className="inline-flex items-center gap-2 text-xs font-medium text-muted-foreground cursor-pointer">
                        <input
                          type="checkbox"
                          aria-label={`Select ${contact.name}`}
                          checked={isSelected}
                          onChange={() => toggleContactSelection(contact.id)}
                          className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                        />
                        Select
                      </label>}
                      <Link href={contactHref(contact.id)} className="text-xs font-medium text-primary hover:underline">
                        {captureMoment ? 'Log moment' : 'Open'}
                      </Link>
                    </div>

                    <Link href={contactHref(contact.id)} className="block">
                      <div className="flex items-start gap-3 mb-3">
                        <Avatar contact={contact} size="sm" className="w-11 h-11" />
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-sm transition-colors truncate hover:text-primary">
                            {contact.name}
                          </p>
                          {contact.nickname && (
                            <p className="text-xs text-muted-foreground truncate">Goes by {contact.nickname}</p>
                          )}
                          {getContactSubtitle(contact) && (
                            <p className="text-xs text-muted-foreground truncate">{getContactSubtitle(contact)}</p>
                          )}
                        </div>
                      </div>

                      <div className={`mb-3 rounded-lg px-3 py-2 ${rhythm.kind === 'ready' ? 'bg-amber-50 text-amber-900' : rhythm.kind === 'due-soon' ? 'bg-sky-50 text-sky-900' : rhythm.kind === 'on-track' ? 'bg-emerald-50 text-emerald-900' : 'bg-stone-50 text-stone-700'}`}>
                        <p className="text-xs font-semibold">{rhythm.label}</p>
                        <p className="mt-0.5 text-[11px] leading-relaxed">{rhythm.detail}</p>
                      </div>

                      {tags.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {tags.map((tag) => (
                            <span
                              key={tag}
                              className="inline-flex px-2 py-0.5 text-[10px] font-medium rounded-full bg-muted text-muted-foreground"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </Link>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ) : (
          <div className="space-y-3 stagger-children">
            {filteredContacts.map((contact) => {
              const rhythm = describeCheckInRhythm(contact);
              const tags = parseTags(contact.tags);
              const isSelected = selectedIdSet.has(contact.id);

              return (
                <Card
                  key={contact.id}
                  className={`border-0 shadow-sm ${isSelected ? 'ring-2 ring-primary/30 bg-primary/5' : ''}`}
                >
                  <CardContent className="pt-4 pb-4 px-4">
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        {selectionMode && <input
                          type="checkbox"
                          aria-label={`Select ${contact.name}`}
                          checked={isSelected}
                          onChange={() => toggleContactSelection(contact.id)}
                          className="h-4 w-4 rounded border-border text-primary focus:ring-primary flex-shrink-0"
                        />}
                        <Avatar contact={contact} size="sm" className="w-10 h-10" />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <Link href={contactHref(contact.id)} className="inline-flex min-h-11 items-center font-semibold text-base truncate">{contact.name}</Link>
                            {contact.nickname && (
                              <span className="text-xs text-muted-foreground">Goes by {contact.nickname}</span>
                            )}
                            {tags.slice(0, 2).map((tag) => (
                              <span key={tag} className="inline-flex px-2 py-0.5 text-[10px] font-medium rounded-full bg-muted text-muted-foreground">
                                {tag}
                              </span>
                            ))}
                          </div>
                          {getContactSubtitle(contact) && (
                            <p className="text-xs text-muted-foreground mt-1 truncate">{getContactSubtitle(contact)}</p>
                          )}
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-4 md:min-w-[320px] md:justify-between">
                        <div className="hidden md:block">
                          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Last touched</p>
                          <p className="text-sm mt-1">{formatRelativeDate(contact.last_contacted)}</p>
                        </div>
                        <div className="hidden md:block">
                          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Check-in rhythm</p>
                          <p className="mt-1 text-sm font-semibold text-foreground">{rhythm.label}</p>
                        </div>
                        <div className="flex items-end md:justify-end">
                          <Link
                            href={contactHref(contact.id)}
                            className={buttonVariants({ variant: 'outline', size: 'sm' })}
                          >
                            {captureMoment ? 'Log moment' : 'Open'}
                          </Link>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )
      ) : (
        <Card className="animate-scale-in border-0 shadow-sm">
          <CardContent className="py-16 text-center">
            {overallTotal === 0 ? (
              <>
                <div className="text-5xl mb-4">👥</div>
                <h3 className="text-lg font-semibold">No contacts yet</h3>
                <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
                  Add one person or preview an import from your address book.
                </p>
                <Link href="/contacts/new" className={buttonVariants({ className: 'mt-4' })}>
                  <Sparkles className="w-4 h-4 mr-2" />
                  Add your first contact
                </Link>
                <Link href="/contacts?import=1" className={buttonVariants({ variant: 'outline', className: 'mt-4 ml-2' })}>Import contacts</Link>
              </>
            ) : (
              <>
                <div className="text-4xl mb-3">🔍</div>
                <h3 className="text-lg font-semibold">No matches</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Try adjusting your search or filters
                </p>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {pagination.totalPages > 1 && filteredContacts.length > 0 && (
        <nav
          aria-label="Contacts pagination"
          className="flex flex-col gap-3 rounded-xl border border-border/60 bg-white p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-center text-xs text-muted-foreground sm:text-left">
            Showing {(pagination.page - 1) * pagination.pageSize + 1}–{Math.min(
              pagination.page * pagination.pageSize,
              pagination.total
            )} of {pagination.total} matching {pagination.total === 1 ? 'contact' : 'contacts'}
          </p>
          <div className="flex items-center justify-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-8"
              disabled={refreshing || pagination.page <= 1}
              aria-disabled={refreshing || pagination.page <= 1}
              onClick={() => navigateDirectory({ page: Math.max(1, pagination.page - 1) })}
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </Button>
            <span className="min-w-20 text-center text-xs font-medium">
              Page {pagination.page} of {pagination.totalPages}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-8"
              disabled={refreshing || pagination.page >= pagination.totalPages}
              aria-disabled={refreshing || pagination.page >= pagination.totalPages}
              onClick={() => navigateDirectory({ page: Math.min(pagination.totalPages, pagination.page + 1) })}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </nav>
      )}
    </div>
  );
}
