'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { CheckSquare, Download, FolderMinus, FolderPlus, LayoutGrid, List, Search, Sparkles, Square, Tag, Trash2, Upload, UserPlus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import type { Contact, ContactGroup } from '@/lib/db';
import { Avatar } from '@/components/ui/avatar';
import { calculateRelationshipHealth, formatRelativeDate, getResponseErrorMessage, parseCustomFields, parseTags } from '@/lib/utils';
import { useToast } from '@/components/ui/toast';

type GroupWithCount = ContactGroup & { member_count: number };
type BulkAction = 'delete' | 'add_tag' | 'remove_tag' | 'add_to_group' | 'remove_from_group';
type ViewMode = 'grid' | 'list';

const BULK_ACTION_OPTIONS: Array<{ value: BulkAction; label: string }> = [
  { value: 'delete', label: 'Delete contacts' },
  { value: 'add_tag', label: 'Add tag' },
  { value: 'remove_tag', label: 'Remove tag' },
  { value: 'add_to_group', label: 'Add to group' },
  { value: 'remove_from_group', label: 'Remove from group' },
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

  if (operation === 'add_to_group') {
    return `Added ${affected} ${affected === 1 ? 'contact' : 'contacts'} to the group`;
  }

  return `Removed ${affected} ${affected === 1 ? 'contact' : 'contacts'} from the group`;
}

function getContactSubtitle(contact: Contact): string | null {
  const customFields = parseCustomFields(contact.custom_fields);
  const linkedIn = customFields.linkedin;

  if (linkedIn && typeof linkedIn === 'object') {
    const linkedInMeta = linkedIn as Record<string, unknown>;
    const company = typeof linkedInMeta.company === 'string' ? linkedInMeta.company : null;
    const location = typeof linkedInMeta.location === 'string' ? linkedInMeta.location : null;
    if (company && location) return `${company} · ${location}`;
    if (company) return company;
    if (location) return location;
  }

  return contact.email || contact.phone || null;
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [groups, setGroups] = useState<GroupWithCount[]>([]);
  const [filteredContacts, setFilteredContacts] = useState<Contact[]>([]);
  const [search, setSearch] = useState('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [selectedContactIds, setSelectedContactIds] = useState<number[]>([]);
  const [bulkAction, setBulkAction] = useState<BulkAction>('delete');
  const [bulkValue, setBulkValue] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const { toast } = useToast();

  async function refreshData() {
    const [contactsRes, groupsRes] = await Promise.all([
      fetch('/api/contacts', { cache: 'no-store' }),
      fetch('/api/groups', { cache: 'no-store' }),
    ]);

    if (!contactsRes.ok) {
      throw new Error(await getResponseErrorMessage(contactsRes, 'Failed to fetch contacts'));
    }

    if (!groupsRes.ok) {
      throw new Error(await getResponseErrorMessage(groupsRes, 'Failed to fetch groups'));
    }

    const contactsData = await contactsRes.json();
    const groupsData = await groupsRes.json();

    const nextContacts = Array.isArray(contactsData.contacts) ? contactsData.contacts : [];
    setContacts(nextContacts);
    setFilteredContacts(nextContacts);
    setGroups(Array.isArray(groupsData.groups) ? groupsData.groups : []);
  }

  useEffect(() => {
    const stored = window.localStorage.getItem('contacts-view-mode');
    if (stored === 'list' || stored === 'grid') {
      setViewMode(stored);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem('contacts-view-mode', viewMode);
  }, [viewMode]);

  useEffect(() => {
    refreshData()
      .catch((error) => {
        console.error('Failed to fetch contacts page data:', error);
        toast({ message: error instanceof Error ? error.message : 'Failed to fetch contacts', variant: 'error' });
      })
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(() => {
    let filtered = contacts;

    if (search) {
      const searchLower = search.toLowerCase();
      filtered = filtered.filter(
        (contact) =>
          contact.name.toLowerCase().includes(searchLower) ||
          contact.email?.toLowerCase().includes(searchLower) ||
          contact.notes?.toLowerCase().includes(searchLower)
      );
    }

    if (selectedTag) {
      filtered = filtered.filter((contact) => parseTags(contact.tags).includes(selectedTag));
    }

    setFilteredContacts(filtered);
  }, [search, selectedTag, contacts]);

  useEffect(() => {
    setSelectedContactIds((previous) =>
      previous.filter((contactId) => contacts.some((contact) => contact.id === contactId))
    );
  }, [contacts]);

  const allTags = Array.from(
    new Set(contacts.flatMap((contact) => parseTags(contact.tags)))
  ).sort();

  const selectedIdSet = useMemo(() => new Set(selectedContactIds), [selectedContactIds]);
  const filteredContactIds = filteredContacts.map((contact) => contact.id);
  const areAllFilteredSelected = filteredContactIds.length > 0 && filteredContactIds.every((id) => selectedIdSet.has(id));
  const selectedCount = selectedContactIds.length;
  const hiddenSelectedCount = selectedContactIds.filter((id) => !filteredContactIds.includes(id)).length;
  const bulkActionNeedsTag = bulkAction === 'add_tag' || bulkAction === 'remove_tag';
  const bulkActionNeedsGroup = bulkAction === 'add_to_group' || bulkAction === 'remove_from_group';
  const canApplyBulkAction =
    selectedCount > 0 &&
    !bulkSubmitting &&
    (!bulkActionNeedsTag || bulkValue.trim().length > 0) &&
    (!bulkActionNeedsGroup || bulkValue.trim().length > 0);

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

  async function handleBulkAction() {
    if (!canApplyBulkAction) {
      return;
    }

    if (bulkAction === 'delete' && !confirm(`Delete ${selectedCount} selected ${selectedCount === 1 ? 'contact' : 'contacts'}?`)) {
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

      if (bulkActionNeedsGroup) {
        payload.groupId = Number(bulkValue);
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
      await refreshData();
      setSelectedContactIds([]);
      setBulkValue('');
      toast({ message: getBulkSuccessMessage(bulkAction, Number(data.affected) || 0) });
    } catch (error) {
      console.error('Failed to apply bulk contact action:', error);
      toast({ message: 'Failed to apply bulk action', variant: 'error' });
    } finally {
      setBulkSubmitting(false);
    }
  }

  if (loading) {
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

  return (
    <div className="space-y-6">
      <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4 animate-fade-in">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold">Your people</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {contacts.length} {contacts.length === 1 ? 'contact' : 'contacts'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="inline-flex rounded-lg border border-border/70 bg-white shadow-sm overflow-hidden">
            <button
              onClick={() => setViewMode('grid')}
              className={`px-3 h-9 inline-flex items-center gap-2 text-sm ${viewMode === 'grid' ? 'bg-primary text-white' : 'text-muted-foreground hover:bg-muted/40'}`}
            >
              <LayoutGrid className="w-4 h-4" />
              Grid
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`px-3 h-9 inline-flex items-center gap-2 text-sm ${viewMode === 'list' ? 'bg-primary text-white' : 'text-muted-foreground hover:bg-muted/40'}`}
            >
              <List className="w-4 h-4" />
              Compact list
            </button>
          </div>
          <a href="/api/export/csv" download>
            <Button variant="outline" size="sm" className="text-muted-foreground">
              <Download className="w-3.5 h-3.5 mr-1.5" />
              Export
            </Button>
          </a>
          <Button
            variant="outline"
            size="sm"
            className="text-muted-foreground"
            disabled={importing}
            onClick={() => document.getElementById('csv-import')?.click()}
          >
            <Upload className="w-3.5 h-3.5 mr-1.5" />
            {importing ? 'Importing...' : 'Import'}
          </Button>
          <input
            id="csv-import"
            type="file"
            accept=".csv"
            className="hidden"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              setImporting(true);
              try {
                const formData = new FormData();
                formData.append('file', file);
                const res = await fetch('/api/import/csv', { method: 'POST', body: formData });
                const data = await res.json();
                if (res.ok) {
                  toast({ message: `Imported ${data.imported} contacts${data.skipped ? `, ${data.skipped} skipped` : ''}` });
                  await refreshData();
                } else {
                  toast({ message: data.error || 'Import failed', variant: 'error' });
                }
              } catch {
                toast({ message: 'Failed to import CSV', variant: 'error' });
              } finally {
                setImporting(false);
                event.target.value = '';
              }
            }}
          />
          <Link href="/contacts/new">
            <Button size="sm">
              <UserPlus className="w-3.5 h-3.5 mr-1.5" />
              Add contact
            </Button>
          </Link>
        </div>
      </div>

      {contacts.length > 0 && (
        <Card className="border-0 shadow-sm animate-fade-in-up">
          <CardContent className="pt-5 pb-4 space-y-4">
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
              <div>
                <p className="font-semibold text-sm text-foreground">
                  {selectedCount > 0 ? `${selectedCount} selected` : 'Bulk actions'}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Select contacts from the grid or compact list, then update tags, group membership, or delete together.
                  {hiddenSelectedCount > 0 ? ` ${hiddenSelectedCount} selected contact${hiddenSelectedCount === 1 ? '' : 's'} are hidden by your current filters.` : ''}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={toggleSelectAllFiltered} disabled={filteredContacts.length === 0}>
                  {areAllFilteredSelected ? <Square className="w-3.5 h-3.5 mr-1.5" /> : <CheckSquare className="w-3.5 h-3.5 mr-1.5" />}
                  {areAllFilteredSelected ? 'Clear filtered' : `Select filtered (${filteredContacts.length})`}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSelectedContactIds([])} disabled={selectedCount === 0}>
                  <X className="w-3.5 h-3.5 mr-1.5" />
                  Clear selection
                </Button>
              </div>
            </div>

            <div className="flex flex-col xl:flex-row gap-3">
              <select
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
                    placeholder={bulkAction === 'add_tag' ? 'Tag to add...' : 'Tag to remove...'}
                    className="pl-9 h-10"
                  />
                </div>
              )}

              {bulkActionNeedsGroup && (
                <div className="relative flex-1">
                  {bulkAction === 'add_to_group' ? (
                    <FolderPlus className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                  ) : (
                    <FolderMinus className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                  )}
                  <select
                    value={bulkValue}
                    onChange={(event) => setBulkValue(event.target.value)}
                    className="flex h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 py-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="">Select a group...</option>
                    {groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <Button
                onClick={handleBulkAction}
                disabled={!canApplyBulkAction || (bulkActionNeedsGroup && groups.length === 0)}
                variant={bulkAction === 'delete' ? 'destructive' : 'default'}
                className="xl:min-w-36"
              >
                {bulkAction === 'delete' ? <Trash2 className="w-4 h-4 mr-1.5" /> : null}
                {bulkSubmitting ? 'Applying...' : 'Apply'}
              </Button>
            </div>

            {bulkActionNeedsGroup && groups.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Create a group first before using group bulk actions.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <div className="space-y-3 animate-fade-in-up">
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4" />
          <Input
            type="text"
            placeholder="Search by name, email, notes, or imported context..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="pl-10 h-11 bg-white border-border/60 focus:border-primary/40 rounded-xl"
          />
        </div>

        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setSelectedTag(null)}
              className={`px-3 py-1 text-xs font-medium rounded-full transition-all ${
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
                onClick={() => setSelectedTag(tag)}
                className={`px-3 py-1 text-xs font-medium rounded-full transition-all ${
                  selectedTag === tag
                    ? 'bg-primary text-white shadow-sm'
                    : 'bg-muted text-muted-foreground hover:bg-muted/70'
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
      </div>

      {filteredContacts.length > 0 ? (
        viewMode === 'grid' ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 stagger-children">
            {filteredContacts.map((contact) => {
              const health = calculateRelationshipHealth(contact);
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
                    <div className="flex items-center justify-between mb-3">
                      <label className="inline-flex items-center gap-2 text-xs font-medium text-muted-foreground cursor-pointer">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleContactSelection(contact.id)}
                          className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                        />
                        Select
                      </label>
                      <Link href={`/contacts/${contact.id}`} className="text-xs font-medium text-primary hover:underline">
                        Open
                      </Link>
                    </div>

                    <Link href={`/contacts/${contact.id}`} className="block">
                      <div className="flex items-start gap-3 mb-3">
                        <Avatar contact={contact} size="sm" className="w-11 h-11" />
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-sm transition-colors truncate hover:text-primary">
                            {contact.name}
                          </p>
                          {getContactSubtitle(contact) && (
                            <p className="text-xs text-muted-foreground truncate">{getContactSubtitle(contact)}</p>
                          )}
                        </div>
                      </div>

                      <div className="mb-3">
                        <div className="flex justify-between text-[10px] mb-1">
                          <span className="text-muted-foreground">Health</span>
                          <span className={`font-semibold ${
                            health >= 75 ? 'text-emerald-600' : health >= 50 ? 'text-amber-600' : 'text-red-500'
                          }`}>
                            {health}%
                          </span>
                        </div>
                        <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                          <div
                            className={`h-full rounded-full animate-health-fill ${
                              health >= 75
                                ? 'bg-gradient-to-r from-emerald-400 to-green-500'
                                : health >= 50
                                  ? 'bg-gradient-to-r from-amber-400 to-orange-500'
                                  : 'bg-gradient-to-r from-red-400 to-rose-500'
                            }`}
                            style={{ width: `${health}%` }}
                          />
                        </div>
                      </div>

                      <p className="text-[11px] text-muted-foreground mb-2">
                        {formatRelativeDate(contact.last_contacted)}
                      </p>

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
              const health = calculateRelationshipHealth(contact);
              const tags = parseTags(contact.tags);
              const isSelected = selectedIdSet.has(contact.id);

              return (
                <Card
                  key={contact.id}
                  className={`border-0 shadow-sm ${isSelected ? 'ring-2 ring-primary/30 bg-primary/5' : ''}`}
                >
                  <CardContent className="pt-4 pb-4 px-4">
                    <div className="flex flex-col md:flex-row md:items-center gap-3">
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleContactSelection(contact.id)}
                          className="h-4 w-4 rounded border-border text-primary focus:ring-primary flex-shrink-0"
                        />
                        <Avatar contact={contact} size="sm" className="w-10 h-10" />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-semibold text-sm truncate">{contact.name}</p>
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

                      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 md:gap-4 md:min-w-[320px]">
                        <div>
                          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Last touched</p>
                          <p className="text-sm mt-1">{formatRelativeDate(contact.last_contacted)}</p>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Health</p>
                          <p className={`text-sm mt-1 font-semibold ${
                            health >= 75 ? 'text-emerald-600' : health >= 50 ? 'text-amber-600' : 'text-red-500'
                          }`}>
                            {health}%
                          </p>
                        </div>
                        <div className="col-span-2 md:col-span-1 flex items-end md:justify-end">
                          <Link href={`/contacts/${contact.id}`}>
                            <Button variant="outline" size="sm">Open</Button>
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
            {contacts.length === 0 ? (
              <>
                <div className="text-5xl mb-4">👥</div>
                <h3 className="text-lg font-semibold">No contacts yet</h3>
                <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
                  Add the people who matter to you and start tracking your relationships.
                </p>
                <Link href="/contacts/new">
                  <Button className="mt-4">
                    <Sparkles className="w-4 h-4 mr-2" />
                    Add your first contact
                  </Button>
                </Link>
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
    </div>
  );
}
