'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  CheckSquare,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Search,
  RefreshCw,
  Square,
  Tag,
  UserPlus,
  X,
} from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { LoadError } from '@/components/ui/load-error';
import { useToast } from '@/components/ui/toast';
import { getResponseErrorMessage } from '@/lib/utils';

type Pagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

type TagSummary = {
  tag: string;
  contactCount: number;
};

type DirectoryContact = {
  id: number;
  name: string;
  email: string | null;
};

type DirectoryPage = {
  contacts: DirectoryContact[];
  pagination: Pagination;
};

const EMPTY_PAGE: DirectoryPage = {
  contacts: [],
  pagination: { page: 1, pageSize: 30, total: 0, totalPages: 1 },
};

const TAG_COLORS = [
  'bg-secondary0',
  'bg-blue-500',
  'bg-success-soft0',
  'bg-warning-soft0',
  'bg-orange-500',
  'bg-indigo-500',
  'bg-cyan-500',
  'bg-pink-500',
  'bg-teal-500',
];

function getTagColor(tag: string): string {
  const index = tag.split('').reduce((total, character) => total + character.charCodeAt(0), 0)
    % TAG_COLORS.length;
  return TAG_COLORS[index];
}

function SkeletonGroups() {
  return (
    <div className="space-y-6">
      <div className="skeleton h-9 w-40" />
      <div className="space-y-3">
        {[1, 2, 3, 4].map((item) => (
          <div key={item} className="skeleton h-16 rounded-xl" />
        ))}
      </div>
    </div>
  );
}

function DirectoryLoadError({
  message,
  retrying,
  onRetry,
}: {
  message: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div role="alert" className="rounded-xl border border-amber-300 bg-warning-soft p-4 text-amber-950">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">This contact list could not be loaded</p>
          <p className="mt-1 text-xs leading-relaxed text-amber-900">{message}</p>
          <Button type="button" variant="outline" size="sm" className="mt-3" disabled={retrying} onClick={onRetry}>
            <RefreshCw className={`h-3.5 w-3.5 ${retrying ? 'animate-spin' : ''}`} aria-hidden="true" />
            {retrying ? 'Trying again...' : 'Try again'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Pager({
  pagination,
  onPageChange,
}: {
  pagination: Pagination;
  onPageChange: (page: number) => void;
}) {
  if (pagination.totalPages <= 1) return null;
  return (
    <div className="mt-3 flex items-center justify-between gap-2 border-t border-border/50 pt-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="min-h-11 sm:min-h-8"
        disabled={pagination.page <= 1}
        onClick={() => onPageChange(pagination.page - 1)}
      >
        <ChevronLeft className="h-4 w-4" />
        Previous
      </Button>
      <span className="text-xs text-muted-foreground">
        Page {pagination.page} of {pagination.totalPages}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="min-h-11 sm:min-h-8"
        disabled={pagination.page >= pagination.totalPages}
        onClick={() => onPageChange(pagination.page + 1)}
      >
        Next
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}

export default function GroupsPage() {
  const [groups, setGroups] = useState<TagSummary[]>([]);
  const [groupsPagination, setGroupsPagination] = useState<Pagination>({
    page: 1,
    pageSize: 100,
    total: 0,
    totalPages: 1,
  });
  const [groupPage, setGroupPage] = useState(1);
  const [expandedTag, setExpandedTag] = useState<string | null>(null);
  const [members, setMembers] = useState<DirectoryPage>(EMPTY_PAGE);
  const [memberPage, setMemberPage] = useState(1);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [memberReloadToken, setMemberReloadToken] = useState(0);
  const [addingTag, setAddingTag] = useState<string | null>(null);
  const [available, setAvailable] = useState<DirectoryPage>(EMPTY_PAGE);
  const [availablePage, setAvailablePage] = useState(1);
  const [availableError, setAvailableError] = useState<string | null>(null);
  const [availableReloadToken, setAvailableReloadToken] = useState(0);
  const [availableSearch, setAvailableSearch] = useState('');
  const [availableSearchQuery, setAvailableSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [membersLoading, setMembersLoading] = useState(false);
  const [availableLoading, setAvailableLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const { toast } = useToast();

  async function fetchGroups(targetPage: number, signal?: AbortSignal) {
    const response = await fetch(`/api/groups/tags?page=${targetPage}&pageSize=100`, {
      cache: 'no-store',
      signal,
    });
    if (!response.ok) {
      throw new Error(await getResponseErrorMessage(response, 'Failed to fetch groups'));
    }
    const data = await response.json();
    setGroups(Array.isArray(data.tags) ? data.tags : []);
    if (data.pagination) {
      setGroupsPagination(data.pagination);
      if (data.pagination.page !== targetPage) setGroupPage(data.pagination.page);
    }
  }

  async function fetchDirectory(
    tag: string,
    membership: 'members' | 'available',
    targetPage: number,
    search = '',
    signal?: AbortSignal
  ): Promise<DirectoryPage> {
    const params = new URLSearchParams({
      tag,
      membership,
      page: String(targetPage),
      pageSize: '30',
    });
    if (search.trim()) params.set('search', search.trim());
    const response = await fetch(`/api/groups/tags/contacts?${params}`, {
      cache: 'no-store',
      signal,
    });
    if (!response.ok) {
      throw new Error(await getResponseErrorMessage(response, 'Failed to fetch group contacts'));
    }
    return response.json() as Promise<DirectoryPage>;
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => setAvailableSearchQuery(availableSearch), 200);
    return () => window.clearTimeout(timeout);
  }, [availableSearch]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetchGroups(groupPage, controller.signal)
      .then(() => setLoadError(null))
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setLoadError(error instanceof Error ? error.message : 'Failed to fetch groups');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [groupPage, reloadToken]);

  useEffect(() => {
    if (!expandedTag) {
      setMembers(EMPTY_PAGE);
      setMembersError(null);
      return;
    }
    const controller = new AbortController();
    setMembersLoading(true);
    fetchDirectory(expandedTag, 'members', memberPage, '', controller.signal)
      .then((data) => {
        setMembers(data);
        setMembersError(null);
        if (data.pagination.page !== memberPage) setMemberPage(data.pagination.page);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setMembersError(error instanceof Error ? error.message : 'Failed to fetch group contacts');
      })
      .finally(() => {
        if (!controller.signal.aborted) setMembersLoading(false);
      });
    return () => controller.abort();
  }, [expandedTag, memberPage, memberReloadToken]);

  useEffect(() => {
    if (!addingTag) {
      setAvailable(EMPTY_PAGE);
      setAvailableError(null);
      return;
    }
    const controller = new AbortController();
    setAvailableLoading(true);
    fetchDirectory(
      addingTag,
      'available',
      availablePage,
      availableSearchQuery,
      controller.signal
    )
      .then((data) => {
        setAvailable(data);
        setAvailableError(null);
        if (data.pagination.page !== availablePage) setAvailablePage(data.pagination.page);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setAvailableError(error instanceof Error ? error.message : 'Failed to fetch available contacts');
      })
      .finally(() => {
        if (!controller.signal.aborted) setAvailableLoading(false);
      });
    return () => controller.abort();
  }, [addingTag, availablePage, availableReloadToken, availableSearchQuery]);

  function toggleSelection(contactId: number) {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(contactId)) next.delete(contactId);
      else next.add(contactId);
      return next;
    });
  }

  async function addSelectedContacts() {
    if (!addingTag || selectedIds.size === 0) return;
    const targetTag = addingTag;
    setAdding(true);
    try {
      const response = await fetch('/api/groups/tags/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: addingTag, contactIds: Array.from(selectedIds) }),
      });
      if (!response.ok) {
        throw new Error(await getResponseErrorMessage(response, 'Failed to add contacts'));
      }
      const data = await response.json() as { affected?: number };
      const affected = Number(data.affected) || 0;
      setSelectedIds(new Set());
      setAddingTag(null);
      setMemberPage(1);
      setMembersError(null);
      setMemberReloadToken((value) => value + 1);
      setGroups((previous) => previous.map((group) =>
        group.tag.toLowerCase() === targetTag.toLowerCase()
          ? { ...group, contactCount: group.contactCount + affected }
          : group
      ));
      toast({ message: `Added ${affected} contact${affected === 1 ? '' : 's'} to “${targetTag}”` });
    } catch (error) {
      toast({ message: error instanceof Error ? error.message : 'Failed to add contacts', variant: 'error' });
    } finally {
      setAdding(false);
    }
  }

  if (loading && !loadError) return <SkeletonGroups />;

  if (loadError) {
    return (
      <div className="space-y-6">
        <div className="animate-fade-in">
          <h1 className="text-2xl font-bold sm:text-3xl">Groups</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">Organize your people using contact tags.</p>
        </div>
        <LoadError
          title="We couldn't load your groups"
          message={`${loadError}. No empty group directory is being shown.`}
          retrying={loading}
          onRetry={() => setReloadToken((value) => value + 1)}
          backHref="/contacts"
          backLabel="Back to contacts"
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="animate-fade-in">
        <h1 className="text-2xl font-bold sm:text-3xl">Groups</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {groupsPagination.total} {groupsPagination.total === 1 ? 'group' : 'groups'} from your contact tags
        </p>
      </div>

      {groups.length > 0 ? (
        <div className="space-y-3 stagger-children">
          {groups.map((group, groupIndex) => {
            const isExpanded = expandedTag?.toLowerCase() === group.tag.toLowerCase();
            const isAdding = addingTag?.toLowerCase() === group.tag.toLowerCase();
            const panelId = `tag-group-panel-${groupIndex}`;
            const visibleAvailableIds = available.contacts.map((contact) => contact.id);
            const pageSelected = visibleAvailableIds.length > 0
              && visibleAvailableIds.every((id) => selectedIds.has(id));

            return (
              <Card key={group.tag.toLowerCase()} className="border-border/70 shadow-card">
                <CardContent className="pb-4 pt-4">
                  <button
                    type="button"
                    onClick={() => {
                      setExpandedTag(isExpanded ? null : group.tag);
                      setMemberPage(1);
                      setMembersError(null);
                      setAddingTag(null);
                      setSelectedIds(new Set());
                    }}
                    className="flex min-h-11 w-full items-center gap-3 text-left"
                    aria-expanded={isExpanded}
                    aria-controls={panelId}
                  >
                    <div className={`h-4 w-4 flex-shrink-0 rounded-full ${getTagColor(group.tag)}`} />
                    <span className="flex-1 truncate text-sm font-semibold">{group.tag}</span>
                    <Badge variant="secondary" className="flex-shrink-0 text-xs font-normal">
                      {group.contactCount} {group.contactCount === 1 ? 'contact' : 'contacts'}
                    </Badge>
                    {isExpanded
                      ? <ChevronDown className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                      : <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />}
                  </button>

                  {isExpanded && (
                    <div id={panelId} className="mt-4 border-t border-border/50 pt-4 animate-slide-down">
                      {membersError ? (
                        <DirectoryLoadError
                          message={`${membersError}. No empty membership claim is being shown.`}
                          retrying={membersLoading}
                          onRetry={() => setMemberReloadToken((value) => value + 1)}
                        />
                      ) : membersLoading ? (
                        <div className="space-y-2">
                          {[1, 2, 3].map((item) => <div key={item} className="skeleton h-12 rounded-xl" />)}
                        </div>
                      ) : members.contacts.length > 0 ? (
                        <div className="space-y-1">
                          {members.contacts.map((contact) => (
                            <Link
                              key={contact.id}
                              href={`/contacts/${contact.id}`}
                              className="flex min-h-11 items-center gap-3 rounded-xl p-2 transition-colors hover:bg-muted/50"
                            >
                              <Avatar contact={contact} size="sm" className="h-8 w-8" />
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium transition-colors hover:text-primary">{contact.name}</p>
                                {contact.email && <p className="truncate text-xs text-muted-foreground">{contact.email}</p>}
                              </div>
                            </Link>
                          ))}
                          <Pager pagination={members.pagination} onPageChange={setMemberPage} />
                        </div>
                      ) : (
                        <p className="py-3 text-sm text-muted-foreground">No contacts in this group.</p>
                      )}

                      {!isAdding ? (
                        <button
                          type="button"
                          onClick={() => {
                            setAddingTag(group.tag);
                            setAvailablePage(1);
                            setAvailableError(null);
                            setAvailableSearch('');
                            setSelectedIds(new Set());
                          }}
                          className="mt-3 flex min-h-11 w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-primary"
                        >
                          <UserPlus className="h-4 w-4" />
                          Add contacts to this group
                        </button>
                      ) : (
                        <div className="mt-3 space-y-3 border-t border-border/50 pt-3 animate-slide-down">
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-xs font-medium text-muted-foreground">
                              Add contacts to “{group.tag}”
                            </p>
                            <button
                              type="button"
                              onClick={() => {
                                setAddingTag(null);
                                setAvailableError(null);
                                setSelectedIds(new Set());
                              }}
                              className="flex h-11 w-11 items-center justify-center rounded-lg hover:bg-muted sm:h-8 sm:w-8"
                              aria-label={`Close add contacts panel for ${group.tag}`}
                            >
                              <X className="h-4 w-4 text-muted-foreground" />
                            </button>
                          </div>

                          <div className="relative">
                            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                              aria-label={`Search contacts to add to ${group.tag}`}
                              value={availableSearch}
                              onChange={(event) => {
                                setAvailableSearch(event.target.value);
                                setAvailablePage(1);
                                setSelectedIds(new Set());
                              }}
                              placeholder="Search available contacts..."
                              className="h-11 pl-9"
                            />
                          </div>

                          {availableError ? (
                            <DirectoryLoadError
                              message={`${availableError}. No availability claim is being shown.`}
                              retrying={availableLoading}
                              onRetry={() => setAvailableReloadToken((value) => value + 1)}
                            />
                          ) : availableLoading ? (
                            <div className="space-y-2">
                              {[1, 2, 3].map((item) => <div key={item} className="skeleton h-11 rounded-xl" />)}
                            </div>
                          ) : available.contacts.length > 0 ? (
                            <>
                              <button
                                type="button"
                                onClick={() => setSelectedIds((previous) => {
                                  const next = new Set(previous);
                                  for (const id of visibleAvailableIds) {
                                    if (pageSelected) next.delete(id);
                                    else next.add(id);
                                  }
                                  return next;
                                })}
                                className="inline-flex min-h-11 items-center gap-2 text-xs font-medium text-primary sm:min-h-8"
                              >
                                {pageSelected ? <Square className="h-4 w-4" /> : <CheckSquare className="h-4 w-4" />}
                                {pageSelected ? 'Clear page' : `Select page (${available.contacts.length})`}
                              </button>
                              <div className="max-h-72 space-y-0.5 overflow-y-auto">
                                {available.contacts.map((contact) => (
                                  <label
                                    key={contact.id}
                                    className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl p-2 transition-colors hover:bg-muted/50"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={selectedIds.has(contact.id)}
                                      onChange={() => toggleSelection(contact.id)}
                                      className="h-4 w-4 rounded border-border text-primary focus:ring-primary/20"
                                    />
                                    <Avatar contact={contact} size="sm" className="h-7 w-7" />
                                    <span className="truncate text-sm">{contact.name}</span>
                                  </label>
                                ))}
                              </div>
                              <Pager
                                pagination={available.pagination}
                                onPageChange={(nextPage) => {
                                  setAvailablePage(nextPage);
                                  setSelectedIds(new Set());
                                }}
                              />
                              <Button
                                type="button"
                                className="min-h-11"
                                disabled={selectedIds.size === 0 || adding}
                                onClick={addSelectedContacts}
                              >
                                {adding ? 'Adding...' : `Add ${selectedIds.size} selected`}
                              </Button>
                            </>
                          ) : (
                            <p className="py-4 text-center text-xs text-muted-foreground">
                              {availableSearch ? 'No available contacts match that search.' : 'All contacts already belong to this group.'}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}

          <Pager pagination={groupsPagination} onPageChange={setGroupPage} />
        </div>
      ) : (
        <Card className="border-border/70 shadow-card animate-scale-in">
          <CardContent className="py-16 text-center">
            <Tag className="mx-auto h-12 w-12 text-muted-foreground" />
            <h2 className="mt-4 text-lg font-semibold">No groups yet</h2>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
              Add tags such as friend, work, or tennis to a contact and they will appear here as groups.
            </p>
            <Link href="/contacts" className={buttonVariants({ className: 'mt-4' })}>
              Go to contacts
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
