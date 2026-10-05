'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  Baby,
  Bell,
  Briefcase,
  Building2,
  Calendar,
  CalendarClock,
  Check,
  Coffee,
  Edit,
  Facebook,
  Gift,
  Globe,
  Instagram,
  Linkedin,
  Link2,
  Mail,
  MapPin,
  MessageSquare,
  MoreHorizontal,
  Phone,
  Plus,
  StickyNote,
  Trash2,
  Twitter,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Avatar } from '@/components/ui/avatar';
import type { Contact, Interaction, Plan, RelationshipFact, Reminder } from '@/lib/db';
import type {
  ContactChildItem,
  ContactRelationshipItem,
} from '@/lib/contact-connections';
import {
  createIdempotencyKey,
  formatDate,
  getResponseErrorMessage,
  getSocialLinks,
  parseCustomFields,
  parseGiftIdeas,
  parseTags,
  createResponseError,
  ResponseError,
} from '@/lib/utils';
import { describeCheckInRhythm } from '@/lib/check-in-rhythm';
import { useToast } from '@/components/ui/toast';
import { MentionText } from '@/components/ui/mention-text';
import { MentionInput } from '@/components/ui/mention-input';
import { LoadError } from '@/components/ui/load-error';
import { contactMethodHref, readContactMethods } from '@/packages/domain/src/contact-methods';
import { PersonCalendarContext } from '@/components/person-calendar-context';
import { PersonGmailContext } from '@/components/person-gmail-context';

type RelationshipBrief = {
  headline: string;
  summary: string;
  nextStep: string;
  talkingPoints: string[];
  suggestedOutreach: string[];
  momentum: 'strong' | 'steady' | 'stale';
};

type TimelineItem = {
  id: string;
  kind: 'interaction' | 'reminder' | 'fact' | 'signal';
  title: string;
  summary: string;
  date: string;
  tone: 'warm' | 'info' | 'urgent';
};

type HistoryPagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

type ContactHistoryState = {
  interactions: HistoryPagination;
  reminders: HistoryPagination;
  facts: HistoryPagination;
  plans: HistoryPagination;
  timeline: HistoryPagination;
};

type ContactHistoryView = keyof ContactHistoryState;
type MobileProfileSection = 'overview' | 'activity' | 'details';
type ActivityFilter = 'all' | 'interaction' | 'reminder' | 'fact' | 'signal';

const ACTIVITY_FILTERS: Array<{ value: ActivityFilter; label: string }> = [
  { value: 'all', label: 'All activity' },
  { value: 'interaction', label: 'Conversations' },
  { value: 'reminder', label: 'Reminders' },
  { value: 'fact', label: 'Context' },
  { value: 'signal', label: 'Milestones' },
];

type EditableInteraction = Interaction & {
  edit_revision: string;
};

type RelationshipDeleteTarget =
  | { kind: 'interaction'; id: number; label: string }
  | { kind: 'plan'; id: number; label: string };

type ConnectionDeleteTarget =
  | { kind: 'relationship'; id: number; label: string }
  | { kind: 'child'; id: number; label: string };

type ContactOption = {
  id: number;
  name: string;
  email: string | null;
};

type ConnectionPagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

type ContactConnectionsState = {
  relationships: ConnectionPagination;
  children: ConnectionPagination;
};

type ContactLoadFailure = {
  status: number | null;
  message: string;
  changeCommitted: boolean;
};

function createEmptyHistoryState(): ContactHistoryState {
  const empty = (): HistoryPagination => ({
    page: 1,
    pageSize: 1,
    total: 0,
    totalPages: 1,
  });
  return {
    interactions: empty(),
    reminders: empty(),
    facts: empty(),
    plans: empty(),
    timeline: empty(),
  };
}

function createEmptyConnectionsState(): ContactConnectionsState {
  const empty = (): ConnectionPagination => ({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
  return { relationships: empty(), children: empty() };
}

type ContactResponse = {
  contact: Contact;
  interactions: EditableInteraction[];
  reminders: Reminder[];
  facts: RelationshipFact[];
  plans: Plan[];
  relationships: ContactRelationshipItem[];
  children: ContactChildItem[];
  brief: RelationshipBrief;
  timeline: TimelineItem[];
  history: ContactHistoryState;
  connections: ContactConnectionsState;
};

async function loadContactResponse(id: string, signal?: AbortSignal): Promise<ContactResponse> {
  const query = new URLSearchParams({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const res = await fetch(`/api/contacts/${id}?${query}`, { cache: 'no-store', signal });
  if (!res.ok) {
    throw await createResponseError(res, 'Failed to fetch contact');
  }

  const data = await res.json() as ContactResponse;
  if (!data.contact) throw new Error('The contact response was incomplete');
  return data;
}

const interactionTypeConfig: Record<string, { icon: React.ElementType; color: string; bg: string }> = {
  call: { icon: Phone, color: 'text-blue-600', bg: 'bg-blue-100' },
  message: { icon: MessageSquare, color: 'text-emerald-600', bg: 'bg-emerald-100' },
  meetup: { icon: Coffee, color: 'text-amber-600', bg: 'bg-amber-100' },
  email: { icon: Mail, color: 'text-purple-600', bg: 'bg-purple-100' },
};

const RELATIONSHIP_LABEL_OPTIONS = [
  'Husband',
  'Wife',
  'Spouse',
  'Partner',
  'Parent',
  'Child',
  'Sibling',
  'Friend',
  'Colleague',
];

function getTimelineToneClasses(tone: TimelineItem['tone']) {
  if (tone === 'urgent') return 'bg-rose-50 text-rose-700 border-rose-200/60';
  if (tone === 'warm') return 'bg-amber-50 text-amber-700 border-amber-200/60';
  return 'bg-slate-50 text-slate-700 border-slate-200/60';
}

export default function ContactDetail() {
  const params = useParams();
  const id = params.id as string;
  const router = useRouter();
  const { toast } = useToast();
  const [contact, setContact] = useState<Contact | null>(null);
  const [interactions, setInteractions] = useState<EditableInteraction[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [facts, setFacts] = useState<RelationshipFact[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [relationships, setRelationships] = useState<ContactRelationshipItem[]>([]);
  const [children, setChildren] = useState<ContactChildItem[]>([]);
  const [connections, setConnections] = useState<ContactConnectionsState>(createEmptyConnectionsState);
  const [brief, setBrief] = useState<RelationshipBrief | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [history, setHistory] = useState<ContactHistoryState>(createEmptyHistoryState);
  const [loadingMore, setLoadingMore] = useState<ContactHistoryView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailure, setLoadFailure] = useState<ContactLoadFailure | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deletingContact, setDeletingContact] = useState(false);
  const [showLogForm, setShowLogForm] = useState(false);
  const [mobileSection, setMobileSection] = useState<MobileProfileSection>('overview');
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all');
  const [filteredTimeline, setFilteredTimeline] = useState<TimelineItem[]>([]);
  const [filteredPagination, setFilteredPagination] = useState<HistoryPagination>({ page: 1, pageSize: 30, total: 0, totalPages: 1 });
  const [filterLoading, setFilterLoading] = useState(false);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [activityRevision, setActivityRevision] = useState(0);
  const [loadingInteractionId, setLoadingInteractionId] = useState<number | null>(null);
  const [showPlanForm, setShowPlanForm] = useState(false);
  const [showReminderForm, setShowReminderForm] = useState(false);
  const [showRelationshipForm, setShowRelationshipForm] = useState(false);
  const [showChildForm, setShowChildForm] = useState(false);
  const [editingChildId, setEditingChildId] = useState<number | null>(null);
  const [childSearch, setChildSearch] = useState('');
  const [childOptions, setChildOptions] = useState<ContactOption[]>([]);
  const [relationshipSearch, setRelationshipSearch] = useState('');
  const [relationshipOptions, setRelationshipOptions] = useState<ContactOption[]>([]);
  const [relationshipForm, setRelationshipForm] = useState({
    related_contact_id: '',
    related_name: '',
    relationship_label: 'Partner',
    reciprocal_label: 'Partner',
  });
  const [childForm, setChildForm] = useState({
    name: '', birthday: '', linked_contact_id: '', linked_name: '', expected_updated_at: '',
  });
  const [connectionDeleteTarget, setConnectionDeleteTarget] = useState<ConnectionDeleteTarget | null>(null);
  const [savingConnection, setSavingConnection] = useState(false);
  const [deletingConnection, setDeletingConnection] = useState(false);
  const [loadingMoreConnections, setLoadingMoreConnections] = useState<'relationships' | 'children' | null>(null);
  const [planForm, setPlanForm] = useState({
    type: 'call',
    planned_date: '',
    summary: '',
    notes: '',
  });
  const [interactionForm, setInteractionForm] = useState({
    type: 'call',
    date: new Date().toISOString().split('T')[0],
    summary: '',
    notes: '',
  });
  const [reminderForm, setReminderForm] = useState({
    title: '',
    notes: '',
    remind_at: '',
  });
  const [editingInteractionId, setEditingInteractionId] = useState<number | null>(null);
  const [interactionEditConflict, setInteractionEditConflict] = useState(false);
  const [relationshipDeleteTarget, setRelationshipDeleteTarget] = useState<RelationshipDeleteTarget | null>(null);
  const [deletingRelationshipRecord, setDeletingRelationshipRecord] = useState(false);
  const [editInteractionForm, setEditInteractionForm] = useState({
    type: 'call',
    date: '',
    summary: '',
    notes: '',
    expected_edit_revision: '',
  });
  const interactionCreateKey = useRef<string | null>(null);
  const interactionLogRef = useRef<HTMLDivElement>(null);
  const filteredLoadController = useRef<AbortController | null>(null);
  const captureOpenedFor = useRef<string | null>(null);
  const profileMenuRef = useRef<HTMLDetailsElement>(null);
  const reminderCreateKey = useRef<string | null>(null);
  const planCreateKey = useRef<string | null>(null);
  const relationshipCreateKey = useRef<string | null>(null);
  const childCreateKey = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    loadContactResponse(id, controller.signal)
      .then((data) => {
        setContact(data.contact);
        setInteractions(data.interactions || []);
        setReminders(data.reminders || []);
        setFacts(data.facts || []);
        setPlans(data.plans || []);
        setRelationships(data.relationships || []);
        setChildren(data.children || []);
        setConnections(data.connections || createEmptyConnectionsState());
        setBrief(data.brief || null);
        setTimeline(data.timeline || []);
        setHistory(data.history || createEmptyHistoryState());
        setLoadFailure(null);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.error('Failed to fetch contact:', error);
        setContact(null);
        setLoadFailure({
          status: error instanceof ResponseError ? error.status : null,
          message: error instanceof Error ? error.message : 'Failed to fetch contact',
          changeCommitted: false,
        });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [id, reloadToken]);

  useEffect(() => {
    if (!contact || String(contact.id) !== id || captureOpenedFor.current === id) return;
    if (new URLSearchParams(window.location.search).get('capture') !== 'moment') return;
    captureOpenedFor.current = id;
    setMobileSection('activity');
    setActivityFilter('interaction');
    setShowLogForm(true);
    const timer = window.setTimeout(() => interactionLogRef.current?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start',
    }), 80);
    return () => window.clearTimeout(timer);
  }, [contact, id]);

  useEffect(() => {
    if (activityFilter === 'all' || activityFilter === 'interaction') {
      setFilterError(null);
      setFilterLoading(false);
      return;
    }
    const controller = new AbortController();
    setFilterLoading(true);
    setFilterError(null);
    setFilteredTimeline([]);
    setFilteredPagination({ page: 1, pageSize: 30, total: 0, totalPages: 1 });
    const query = new URLSearchParams({ view: 'timeline', kind: activityFilter });
    fetch(`/api/contacts/${id}?${query}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not load activity'));
        return response.json() as Promise<{ timeline: TimelineItem[]; pagination: HistoryPagination }>;
      })
      .then((data) => {
        if (!controller.signal.aborted) {
          setFilteredTimeline(data.timeline || []);
          setFilteredPagination(data.pagination);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setFilterError(error instanceof Error ? error.message : 'Could not load activity');
      })
      .finally(() => { if (!controller.signal.aborted) setFilterLoading(false); });
    return () => controller.abort();
  }, [activityFilter, activityRevision, id]);

  useEffect(() => () => filteredLoadController.current?.abort(), [activityFilter, id]);

  useEffect(() => {
    if (!showRelationshipForm) {
      setRelationshipOptions([]);
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      const query = new URLSearchParams({
        view: 'mentions',
        search: relationshipSearch,
        limit: '20',
      });
      fetch(`/api/contacts?${query}`, { cache: 'no-store', signal: controller.signal })
        .then((response) => response.ok ? response.json() : { contacts: [] })
        .then((data) => {
          const connectedIds = new Set(relationships.map((relationship) => relationship.related_contact_id));
          setRelationshipOptions((Array.isArray(data.contacts) ? data.contacts : []).filter(
            (option: ContactOption) => option.id !== Number(id) && !connectedIds.has(option.id)
          ));
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          setRelationshipOptions([]);
        });
    }, 150);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [id, relationshipSearch, relationships, showRelationshipForm]);

  useEffect(() => {
    if (!showChildForm || childForm.linked_contact_id) {
      setChildOptions([]);
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      const query = new URLSearchParams({ view: 'mentions', search: childSearch, limit: '20' });
      fetch(`/api/contacts?${query}`, { cache: 'no-store', signal: controller.signal })
        .then((response) => response.ok ? response.json() : { contacts: [] })
        .then((data) => setChildOptions((Array.isArray(data.contacts) ? data.contacts : []).filter(
          (option: ContactOption) => option.id !== Number(id)
            && !children.some((child) => child.id !== editingChildId && child.linked_contact_id === option.id)
        )))
        .catch((error) => {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          setChildOptions([]);
        });
    }, 150);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [childForm.linked_contact_id, childSearch, children, editingChildId, id, showChildForm]);

  async function refreshContact() {
    const data = await loadContactResponse(id);
    setContact(data.contact);
    setInteractions(data.interactions || []);
    setReminders(data.reminders || []);
    setFacts(data.facts || []);
    setPlans(data.plans || []);
    setRelationships(data.relationships || []);
    setChildren(data.children || []);
    setConnections(data.connections || createEmptyConnectionsState());
    setBrief(data.brief || null);
    setTimeline(data.timeline || []);
    setHistory(data.history || createEmptyHistoryState());
    setLoadFailure(null);
    setActivityRevision((current) => current + 1);
  }

  async function refreshAfterCommittedMutation(successMessage: string) {
    toast({ message: successMessage });
    try {
      await refreshContact();
    } catch (error) {
      console.error('Failed to refresh contact after a committed change:', error);
      setContact(null);
      setLoadFailure({
        status: error instanceof ResponseError ? error.status : null,
        message: error instanceof Error ? error.message : 'Failed to refresh contact',
        changeCommitted: true,
      });
    }
  }

  async function loadMoreHistory(view: ContactHistoryView) {
    const current = history[view];
    if (loadingMore || current.page >= current.totalPages) return;
    setLoadingMore(view);

    try {
      const query = new URLSearchParams({
        view,
        page: String(current.page + 1),
        pageSize: String(current.pageSize),
      });
      const response = await fetch(`/api/contacts/${id}?${query}`, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(await getResponseErrorMessage(response, `Failed to load more ${view}`));
      }
      const data = await response.json();
      if (!data.pagination) throw new Error(`Invalid ${view} response`);

      if (view === 'interactions') {
        setInteractions((currentItems) => {
          const seen = new Set(currentItems.map((item) => item.id));
          return [...currentItems, ...(data.interactions || []).filter((item: EditableInteraction) => !seen.has(item.id))];
        });
      } else if (view === 'reminders') {
        setReminders((currentItems) => [...currentItems, ...(data.reminders || [])]);
      } else if (view === 'facts') {
        setFacts((currentItems) => [...currentItems, ...(data.facts || [])]);
      } else if (view === 'plans') {
        setPlans((currentItems) => [...currentItems, ...(data.plans || [])]);
      } else {
        setTimeline((currentItems) => [...currentItems, ...(data.timeline || [])]);
      }
      setHistory((currentHistory) => ({
        ...currentHistory,
        [view]: data.pagination,
      }));
    } catch (error) {
      toast({
        message: error instanceof Error ? error.message : `Failed to load more ${view}`,
        variant: 'error',
      });
    } finally {
      setLoadingMore(null);
    }
  }

  async function loadMoreFilteredTimeline() {
    if (activityFilter === 'all') {
      await loadMoreHistory('timeline');
      return;
    }
    if (activityFilter === 'interaction' || loadingMore || filteredPagination.page >= filteredPagination.totalPages) return;
    const controller = new AbortController();
    filteredLoadController.current = controller;
    setLoadingMore('timeline');
    try {
      const query = new URLSearchParams({
        view: 'timeline',
        kind: activityFilter,
        page: String(filteredPagination.page + 1),
        pageSize: String(filteredPagination.pageSize),
      });
      const response = await fetch(`/api/contacts/${id}?${query}`, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not load older activity'));
      const data = await response.json() as { timeline: TimelineItem[]; pagination: HistoryPagination };
      if (controller.signal.aborted) return;
      if (!data.pagination) throw new Error('Invalid activity response');
      setFilteredTimeline((current) => [...current, ...(data.timeline || [])]);
      setFilteredPagination(data.pagination);
    } catch (error) {
      if (!controller.signal.aborted) toast({ message: error instanceof Error ? error.message : 'Could not load older activity', variant: 'error' });
    } finally {
      if (filteredLoadController.current === controller) {
        filteredLoadController.current = null;
        setLoadingMore(null);
      }
    }
  }

  async function loadMoreConnectionRecords(kind: 'relationships' | 'children') {
    const current = connections[kind];
    if (loadingMoreConnections || current.page >= current.totalPages) return;
    setLoadingMoreConnections(kind);
    try {
      const query = new URLSearchParams({
        page: String(current.page + 1),
        pageSize: String(current.pageSize),
      });
      const response = await fetch(`/api/contacts/${id}/${kind}?${query}`, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(await getResponseErrorMessage(response, `Failed to load more ${kind}`));
      }
      const data = await response.json();
      if (!data.pagination) throw new Error(`Invalid ${kind} response`);
      if (kind === 'relationships') {
        setRelationships((currentItems) => [...currentItems, ...(data.relationships || [])]);
      } else {
        setChildren((currentItems) => [...currentItems, ...(data.children || [])]);
      }
      setConnections((currentConnections) => ({
        ...currentConnections,
        [kind]: data.pagination,
      }));
    } catch (error) {
      toast({
        message: error instanceof Error ? error.message : `Failed to load more ${kind}`,
        variant: 'error',
      });
    } finally {
      setLoadingMoreConnections(null);
    }
  }

  async function handleCreateRelationship(e: React.FormEvent) {
    e.preventDefault();
    if (!relationshipForm.related_contact_id) {
      toast({ message: 'Choose a contact to connect', variant: 'info' });
      return;
    }
    setSavingConnection(true);
    try {
      const idempotencyKey = relationshipCreateKey.current || createIdempotencyKey();
      relationshipCreateKey.current = idempotencyKey;
      const response = await fetch(`/api/contacts/${id}/relationships`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          related_contact_id: relationshipForm.related_contact_id,
          relationship_label: relationshipForm.relationship_label,
          reciprocal_label: relationshipForm.reciprocal_label,
        }),
      });
      if (!response.ok) {
        if (response.status !== 409) relationshipCreateKey.current = null;
        toast({ message: await getResponseErrorMessage(response, 'Failed to connect contacts'), variant: 'error' });
        return;
      }
      relationshipCreateKey.current = null;
      setRelationshipForm({
        related_contact_id: '',
        related_name: '',
        relationship_label: 'Partner',
        reciprocal_label: 'Partner',
      });
      setRelationshipSearch('');
      setShowRelationshipForm(false);
      await refreshAfterCommittedMutation('Contacts connected');
    } catch (error) {
      console.error('Failed to connect contacts:', error);
      toast({
        message: 'We could not confirm whether the connection was saved. Retry without changing the form; the same request will be reused safely.',
        variant: 'error',
      });
    } finally {
      setSavingConnection(false);
    }
  }

  async function handleCreateChild(e: React.FormEvent) {
    e.preventDefault();
    setSavingConnection(true);
    try {
      const idempotencyKey = editingChildId === null ? childCreateKey.current || createIdempotencyKey() : null;
      if (idempotencyKey) childCreateKey.current = idempotencyKey;
      const response = await fetch(`/api/contacts/${id}/children${editingChildId === null ? '' : `/${editingChildId}`}`, {
        method: editingChildId === null ? 'POST' : 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: JSON.stringify({
          name: childForm.name,
          birthday: childForm.birthday,
          linked_contact_id: childForm.linked_contact_id || null,
          ...(editingChildId === null ? {} : { expected_updated_at: childForm.expected_updated_at }),
        }),
      });
      if (!response.ok) {
        if (editingChildId === null && response.status !== 409) childCreateKey.current = null;
        toast({ message: await getResponseErrorMessage(response, 'Failed to save child'), variant: 'error' });
        return;
      }
      childCreateKey.current = null;
      setChildForm({ name: '', birthday: '', linked_contact_id: '', linked_name: '', expected_updated_at: '' });
      setChildSearch('');
      setEditingChildId(null);
      setShowChildForm(false);
      await refreshAfterCommittedMutation(editingChildId === null ? 'Child added' : 'Child updated');
    } catch (error) {
      console.error('Failed to save child:', error);
      toast({
        message: editingChildId === null
          ? 'We could not confirm whether the child was added. Retry without changing the form; the same request will be reused safely.'
          : 'We could not confirm whether the change was saved. Refresh before trying again to avoid overwriting newer changes.',
        variant: 'error',
      });
    } finally {
      setSavingConnection(false);
    }
  }

  async function handleDeleteConnection() {
    if (!connectionDeleteTarget) return;
    setDeletingConnection(true);
    try {
      const collection = connectionDeleteTarget.kind === 'relationship' ? 'relationships' : 'children';
      const response = await fetch(
        `/api/contacts/${id}/${collection}/${connectionDeleteTarget.id}`,
        { method: 'DELETE' }
      );
      if (!response.ok) {
        toast({ message: await getResponseErrorMessage(response, 'Failed to remove record'), variant: 'error' });
        return;
      }
      const result = await response.json() as { alreadyDeleted?: boolean };
      const label = connectionDeleteTarget.kind === 'relationship' ? 'Connection' : 'Child';
      setConnectionDeleteTarget(null);
      await refreshAfterCommittedMutation(
        result.alreadyDeleted ? `${label} was already removed` : `${label} removed`
      );
    } catch (error) {
      console.error('Failed to remove connection record:', error);
      toast({ message: 'Failed to remove record', variant: 'error' });
    } finally {
      setDeletingConnection(false);
    }
  }

  async function handleLogInteraction(e: React.FormEvent) {
    e.preventDefault();
    try {
      const idempotencyKey = interactionCreateKey.current || createIdempotencyKey();
      interactionCreateKey.current = idempotencyKey;
      const res = await fetch('/api/interactions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ contact_id: id, ...interactionForm }),
      });

      if (!res.ok) {
        if (res.status !== 409) interactionCreateKey.current = null;
        toast({ message: await getResponseErrorMessage(res, 'Failed to log interaction'), variant: 'error' });
        return;
      }

      interactionCreateKey.current = null;
      setInteractionForm({ type: 'call', date: new Date().toISOString().split('T')[0], summary: '', notes: '' });
      setShowLogForm(false);
      await refreshAfterCommittedMutation('Interaction logged');
    } catch (error) {
      console.error('Failed to log interaction:', error);
      toast({
        message: 'We could not confirm whether the interaction was logged. Retry without changing the form; the same request will be reused safely.',
        variant: 'error',
      });
    }
  }

  async function handleDelete() {
    setDeletingContact(true);
    try {
      const res = await fetch(`/api/contacts/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        toast({ message: await getResponseErrorMessage(res, 'Failed to delete contact'), variant: 'error' });
        return;
      }
      const result = await res.json() as { alreadyDeleted?: boolean };
      setDeleteConfirmOpen(false);
      toast({
        message: result.alreadyDeleted
          ? 'Contact was already deleted.'
          : 'Contact deleted. A recovery point was saved in Settings.',
      });
      router.push('/contacts');
    } catch (error) {
      console.error('Failed to delete contact:', error);
      toast({ message: 'Failed to delete contact', variant: 'error' });
    } finally {
      setDeletingContact(false);
    }
  }

  async function handleSetReminder(e: React.FormEvent) {
    e.preventDefault();
    try {
      const idempotencyKey = reminderCreateKey.current || createIdempotencyKey();
      reminderCreateKey.current = idempotencyKey;
      const res = await fetch('/api/reminders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          contact_id: id,
          ...reminderForm,
          remind_at: new Date(reminderForm.remind_at).toISOString(),
        }),
      });
      if (!res.ok) {
        if (res.status !== 409) reminderCreateKey.current = null;
        toast({ message: await getResponseErrorMessage(res, 'Failed to set reminder'), variant: 'error' });
        return;
      }
      reminderCreateKey.current = null;
      setReminderForm({ title: '', notes: '', remind_at: '' });
      setShowReminderForm(false);
      await refreshAfterCommittedMutation('Reminder set');
    } catch (error) {
      console.error('Failed to set reminder:', error);
      toast({
        message: 'We could not confirm whether the reminder was set. Retry without changing the form; the same request will be reused safely.',
        variant: 'error',
      });
    }
  }

  function startEditInteraction(interaction: EditableInteraction) {
    setEditingInteractionId(interaction.id);
    setInteractionEditConflict(false);
    setEditInteractionForm({
      type: interaction.type,
      date: interaction.date,
      summary: interaction.summary || '',
      notes: interaction.notes || '',
      expected_edit_revision: interaction.edit_revision,
    });
  }

  async function editFromTimeline(item: TimelineItem) {
    const match = /^interaction-(\d+)$/u.exec(item.id);
    if (!match || loadingInteractionId !== null) return;
    const interactionId = Number(match[1]);
    setLoadingInteractionId(interactionId);
    try {
      const response = await fetch(`/api/interactions/${interactionId}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not open conversation'));
      const data = await response.json() as { interaction?: EditableInteraction };
      if (!data.interaction || data.interaction.contact_id !== Number(id)) throw new Error('Conversation is no longer on this profile');
      const interaction = data.interaction;
      setInteractions((current) => current.some((entry) => entry.id === interaction.id)
        ? current.map((entry) => entry.id === interaction.id ? interaction : entry)
        : [...current, interaction].sort((left, right) => right.date.localeCompare(left.date) || right.id - left.id));
      startEditInteraction(interaction);
      setMobileSection('activity');
      setActivityFilter('interaction');
      window.setTimeout(() => document.getElementById(`interaction-edit-${interaction.id}`)?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'start',
      }), 80);
    } catch (error) {
      toast({ message: error instanceof Error ? error.message : 'Could not open conversation', variant: 'error' });
    } finally {
      setLoadingInteractionId(null);
    }
  }

  async function handleEditInteraction(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await fetch(`/api/interactions/${editingInteractionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editInteractionForm),
      });
      if (!res.ok) {
        if (res.status === 409) setInteractionEditConflict(true);
        toast({ message: await getResponseErrorMessage(res, 'Failed to update interaction'), variant: 'error' });
        return;
      }
      const result = await res.json().catch(() => null) as { interaction?: EditableInteraction } | null;
      setEditingInteractionId(null);
      setInteractionEditConflict(false);
      await refreshAfterCommittedMutation('Interaction updated');
      if (result?.interaction) {
        const updated = result.interaction;
        setInteractions((current) => {
          const withoutUpdated = current.filter((entry) => entry.id !== updated.id);
          return [...withoutUpdated, updated].sort((left, right) => right.date.localeCompare(left.date) || right.id - left.id);
        });
      }
    } catch (error) {
      console.error('Failed to edit interaction:', error);
      toast({ message: 'Failed to update interaction', variant: 'error' });
    }
  }

  async function handleDeleteInteraction(interactionId: number) {
    setDeletingRelationshipRecord(true);
    try {
      const res = await fetch(`/api/interactions/${interactionId}`, { method: 'DELETE' });
      if (!res.ok) {
        toast({ message: await getResponseErrorMessage(res, 'Failed to delete interaction'), variant: 'error' });
        return;
      }
      const result = await res.json() as { alreadyDeleted?: boolean };
      setRelationshipDeleteTarget(null);
      await refreshAfterCommittedMutation(
        result.alreadyDeleted ? 'Interaction was already deleted' : 'Interaction deleted'
      );
    } catch (error) {
      console.error('Failed to delete interaction:', error);
      toast({ message: 'Failed to delete interaction', variant: 'error' });
    } finally {
      setDeletingRelationshipRecord(false);
    }
  }

  async function handleCreatePlan(e: React.FormEvent) {
    e.preventDefault();
    try {
      const idempotencyKey = planCreateKey.current || createIdempotencyKey();
      planCreateKey.current = idempotencyKey;
      const res = await fetch('/api/plans', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ contact_id: id, ...planForm }),
      });
      if (!res.ok) {
        if (res.status !== 409) planCreateKey.current = null;
        toast({ message: await getResponseErrorMessage(res, 'Failed to create plan'), variant: 'error' });
        return;
      }
      planCreateKey.current = null;
      setPlanForm({ type: 'call', planned_date: '', summary: '', notes: '' });
      setShowPlanForm(false);
      await refreshAfterCommittedMutation('Plan scheduled');
    } catch (error) {
      console.error('Failed to create plan:', error);
      toast({
        message: 'We could not confirm whether the plan was scheduled. Retry without changing the form; the same request will be reused safely.',
        variant: 'error',
      });
    }
  }

  async function handleCompletePlan(planId: number) {
    try {
      const res = await fetch(`/api/plans/${planId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed: true }),
      });
      if (!res.ok) {
        toast({ message: await getResponseErrorMessage(res, 'Failed to complete plan'), variant: 'error' });
        return;
      }
      const result = await res.json() as { interactionCreated?: boolean };
      await refreshAfterCommittedMutation(
        result.interactionCreated
          ? 'Plan completed and logged as interaction'
          : 'Plan was already completed'
      );
    } catch (error) {
      console.error('Failed to complete plan:', error);
      toast({ message: 'Failed to complete plan', variant: 'error' });
    }
  }

  async function handleDeletePlan(planId: number) {
    setDeletingRelationshipRecord(true);
    try {
      const res = await fetch(`/api/plans/${planId}`, { method: 'DELETE' });
      if (!res.ok) {
        toast({ message: await getResponseErrorMessage(res, 'Failed to delete plan'), variant: 'error' });
        return;
      }
      const result = await res.json() as { alreadyDeleted?: boolean };
      setRelationshipDeleteTarget(null);
      await refreshAfterCommittedMutation(
        result.alreadyDeleted ? 'Plan was already deleted' : 'Plan deleted'
      );
    } catch (error) {
      console.error('Failed to delete plan:', error);
      toast({ message: 'Failed to delete plan', variant: 'error' });
    } finally {
      setDeletingRelationshipRecord(false);
    }
  }

  if (loading && !loadFailure) {
    return (
      <div className="space-y-6 max-w-5xl mx-auto">
        <div className="skeleton h-10 w-20" />
        <div className="skeleton h-36 rounded-xl" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="skeleton h-56 rounded-xl lg:col-span-2" />
          <div className="skeleton h-56 rounded-xl" />
        </div>
        <div className="skeleton h-72 rounded-xl" />
      </div>
    );
  }

  if (loadFailure?.status === 404 && !loadFailure.changeCommitted) {
    return (
      <div className="text-center py-16">
        <div className="text-4xl mb-3">😢</div>
        <h3 className="text-lg font-semibold">Contact not found</h3>
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
          title="We couldn't load this contact"
          message={loadFailure.changeCommitted
            ? `${loadFailure.message}. Your change was saved, but this page could not refresh safely.`
            : `${loadFailure.message}. Your data has not been changed.`}
          retrying={loading}
          onRetry={() => setReloadToken((value) => value + 1)}
          backHref="/contacts"
          backLabel="Back to contacts"
        />
      </div>
    );
  }

  if (!contact) {
    return (
      <div className="mx-auto max-w-2xl py-8">
        <LoadError
          title="We couldn't load this contact"
          message="The server returned an incomplete response. Your data has not been changed."
          onRetry={() => setReloadToken((value) => value + 1)}
          backHref="/contacts"
          backLabel="Back to contacts"
        />
      </div>
    );
  }

  const rhythm = describeCheckInRhythm(contact);
  const visibleTimeline = activityFilter === 'all' ? timeline : filteredTimeline;
  const visibleTimelinePagination = activityFilter === 'all' ? history.timeline : filteredPagination;
  const tags = parseTags(contact.tags);
  const giftIdeas = parseGiftIdeas(contact.gift_ideas);
  const customFields = parseCustomFields(contact.custom_fields);
  const socialLinks = getSocialLinks(contact.custom_fields);
  const extraMethods = readContactMethods(contact.contact_methods).filter((method) => method.kind === 'profile' || !method.preferred);
  function openLogForm() {
    setMobileSection('activity');
    setActivityFilter('interaction');
    setShowLogForm(true);
    requestAnimationFrame(() => interactionLogRef.current?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start',
    }));
  }
  const linkedInMeta =
    customFields.linkedin && typeof customFields.linkedin === 'object'
      ? customFields.linkedin as Record<string, unknown>
      : null;
  const company = (customFields.company as string) || (linkedInMeta && typeof linkedInMeta.company === 'string' ? linkedInMeta.company : null);
  const jobTitle = (customFields.job_title as string) || (linkedInMeta && typeof linkedInMeta.headline === 'string' ? linkedInMeta.headline : null);
  const location = (customFields.location as string) || (linkedInMeta && typeof linkedInMeta.location === 'string' ? linkedInMeta.location : null);
  const openReminders = reminders.filter((reminder) => !reminder.completed_at);
  const openPlans = plans.filter((plan) => !plan.completed_at);

  const socialIconMap: Record<string, { icon: React.ElementType; label: string }> = {
    linkedin: { icon: Linkedin, label: 'LinkedIn' },
    twitter: { icon: Twitter, label: 'Twitter / X' },
    instagram: { icon: Instagram, label: 'Instagram' },
    facebook: { icon: Facebook, label: 'Facebook' },
    website: { icon: Globe, label: 'Website' },
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4 sm:space-y-6">
      <div className="animate-fade-in">
        <Link href="/contacts" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="w-4 h-4" />
          Back
        </Link>
      </div>

      <Card className="border-0 shadow-sm animate-fade-in-up overflow-hidden">
        <CardContent className="py-5 sm:py-6">
          <div className="flex items-start gap-4 sm:gap-5">
            <Avatar contact={contact} size="xl" className="!h-14 !w-14 !text-lg sm:!h-24 sm:!w-24 sm:!text-3xl" />
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl sm:text-3xl font-bold text-foreground">{contact.name}</h1>
              {contact.nickname && (
                <p className="text-sm text-muted-foreground mt-1">Goes by {contact.nickname}</p>
              )}
              {(jobTitle || company) && (
                <p className="text-sm text-muted-foreground mt-1 flex items-center gap-1.5">
                  {jobTitle && <><Briefcase className="w-3.5 h-3.5 flex-shrink-0" />{jobTitle}</>}
                  {jobTitle && company && <span className="mx-0.5">at</span>}
                  {company && !jobTitle && <Building2 className="w-3.5 h-3.5 flex-shrink-0" />}
                  {company && <span className="font-medium">{company}</span>}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-sm text-muted-foreground">
                {contact.email && (
                  <a href={contactMethodHref({ kind: 'email', value: contact.email })} className="flex items-center gap-1.5 hover:text-primary transition-colors">
                    <Mail className="w-3.5 h-3.5" />
                    {contact.email}
                  </a>
                )}
                {contact.phone && (
                  <a href={contactMethodHref({ kind: 'phone', value: contact.phone })} className="flex items-center gap-1.5 hover:text-primary transition-colors">
                    <Phone className="w-3.5 h-3.5" />
                    {contact.phone}
                  </a>
                )}
                {location && (
                  <span className="flex items-center gap-1.5">
                    <MapPin className="w-3.5 h-3.5" />
                    {location}
                  </span>
                )}
                {contact.birthday && (
                  <span className="flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5" />
                    {formatDate(contact.birthday)}
                    <span className="text-xs">
                      {contact.birthday_reminder_days === 0
                        ? '· alert on the day'
                        : `· alert ${contact.birthday_reminder_days} day${contact.birthday_reminder_days === 1 ? '' : 's'} before`}
                    </span>
                  </span>
                )}
              </div>
              {extraMethods.length > 0 && <div aria-label="Additional contact methods" className="mt-3 flex flex-wrap gap-2">
                {extraMethods.map((method) => <a key={method.id} href={contactMethodHref(method)}
                  target={method.kind === 'profile' ? '_blank' : undefined} rel={method.kind === 'profile' ? 'noreferrer noopener' : undefined}
                  className="flex min-h-11 max-w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:text-primary">
                  {method.kind === 'email' ? <Mail className="h-4 w-4 shrink-0" /> : method.kind === 'phone' ? <Phone className="h-4 w-4 shrink-0" /> : <Globe className="h-4 w-4 shrink-0" />}
                  <span className="min-w-0 break-all">{method.label && <span className="font-medium">{method.label}: </span>}{method.value}{method.country ? ` (${method.country})` : ''}</span>
                </a>)}
              </div>}
              {Object.keys(socialLinks).length > 0 && (
                <div className="mt-3 hidden flex-wrap items-center gap-2 sm:flex">
                  {Object.entries(socialLinks).map(([key, url]) => {
                    const config = socialIconMap[key];
                    if (!config) return null;
                    const SocialIcon = config.icon;
                    return (
                      <a
                        key={key}
                        href={url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full border border-border/60 text-muted-foreground hover:text-primary hover:border-primary/30 transition-colors"
                      >
                        <SocialIcon className="w-3.5 h-3.5" />
                        {config.label}
                      </a>
                    );
                  })}
                </div>
              )}
              {tags.length > 0 && (
                <div className="mt-3 hidden flex-wrap gap-1.5 sm:flex">
                  {tags.map((tag) => (
                    <span key={tag} className="px-2.5 py-0.5 text-xs font-medium rounded-full bg-primary/10 text-primary">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="sticky top-14 z-20 flex items-center gap-2 rounded-xl border border-border/70 bg-white/95 p-2 shadow-sm backdrop-blur sm:relative sm:top-auto sm:w-fit sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none">
        {(contact.phone || contact.email) && (
          <a
            href={contact.phone ? `sms:${contact.phone}` : `mailto:${contact.email}`}
            className={buttonVariants({ variant: 'outline', size: 'sm', className: 'h-11 w-11 shrink-0 p-0 sm:h-9 sm:w-auto sm:px-3' })}
            aria-label={`${contact.phone ? 'Message' : 'Email'} ${contact.name}`}
          >
            <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="sr-only sm:not-sr-only sm:ml-1.5">{contact.phone ? 'Message' : 'Email'}</span>
          </a>
        )}
        <Button size="sm" className="h-11 min-w-0 flex-1 px-2 sm:h-9 lg:flex-none lg:px-3" onClick={openLogForm} aria-controls="interaction-form" aria-expanded={showLogForm}>
          <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
          Log moment
        </Button>
        <Button variant="outline" size="sm" className="h-11 min-w-0 flex-1 px-2 sm:h-9 lg:flex-none lg:px-3" onClick={() => setShowReminderForm(!showReminderForm)} aria-expanded={showReminderForm}>
          <Bell className="h-3.5 w-3.5" aria-hidden="true" />
          Reminder
        </Button>
        <details ref={profileMenuRef} className="relative shrink-0">
          <summary aria-label="More contact actions" className={buttonVariants({ variant: 'outline', size: 'sm', className: 'h-11 w-11 cursor-pointer list-none p-0 text-muted-foreground hover:bg-muted/60 hover:text-foreground sm:h-9 sm:w-9 [&::-webkit-details-marker]:hidden' })}>
            <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
          </summary>
          <div className="absolute right-0 z-30 mt-2 w-44 rounded-xl border border-border bg-white p-2 shadow-lg">
            <Link href={`/contacts/${id}/methods`} className="flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm text-foreground hover:bg-muted/50">Contact methods</Link>
            <Link href={`/contacts/${id}/sources`} className="flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm text-foreground hover:bg-muted/50">Linked sources</Link>
            <Link href={`/calendar/events?contact_id=${id}`} className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm text-foreground hover:bg-muted/50">Calendar context</Link>
            <Link href={`/contacts/${id}/edit`} className="flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm text-foreground hover:bg-muted/50">
              <Edit className="h-4 w-4" aria-hidden="true" />Edit profile
            </Link>
            <button type="button" onClick={() => { profileMenuRef.current?.removeAttribute('open'); setDeleteConfirmOpen(true); }} className="flex min-h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-sm text-destructive hover:bg-destructive/10">
              <Trash2 className="h-4 w-4" aria-hidden="true" />Delete contact
            </button>
          </div>
        </details>
      </div>

      <nav aria-label="Profile sections" className="sticky top-[7.5rem] z-10 grid grid-cols-3 gap-1 rounded-xl border bg-white/95 p-1 shadow-sm backdrop-blur sm:top-16 md:hidden">
        {([
          ['overview', 'Overview'],
          ['activity', 'Activity'],
          ['details', 'Details'],
        ] as const).map(([section, label]) => (
          <button
            key={section}
            type="button"
            aria-pressed={mobileSection === section}
            onClick={() => setMobileSection(section)}
            className={`min-h-10 rounded-lg px-2 text-sm font-semibold ${mobileSection === section ? 'bg-foreground text-white' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'}`}
          >
            {label}
          </button>
        ))}
      </nav>

      <ConfirmDialog
        open={deleteConfirmOpen}
        title={`Delete ${contact.name}?`}
        description="This removes the contact and their interactions, reminders, plans, facts, and group memberships from the active CRM."
        safetyNote="A verified recovery point will be saved first and can be restored from Settings."
        safetyTone="recovery"
        confirmLabel="Delete contact"
        pendingLabel="Saving recovery point..."
        pending={deletingContact}
        onCancel={() => setDeleteConfirmOpen(false)}
        onConfirm={handleDelete}
      />

      <ConfirmDialog
        open={relationshipDeleteTarget !== null}
        title={relationshipDeleteTarget?.kind === 'interaction' ? 'Delete interaction?' : 'Delete plan?'}
        description={relationshipDeleteTarget
          ? `Remove “${relationshipDeleteTarget.label}” from ${contact.name}’s relationship history.`
          : ''}
        safetyNote="This record deletion cannot be undone. The contact and their other relationship history will remain."
        safetyTone="irreversible"
        confirmLabel={relationshipDeleteTarget?.kind === 'interaction' ? 'Delete interaction' : 'Delete plan'}
        pendingLabel="Deleting..."
        pending={deletingRelationshipRecord}
        onCancel={() => setRelationshipDeleteTarget(null)}
        onConfirm={() => {
          if (relationshipDeleteTarget?.kind === 'interaction') {
            void handleDeleteInteraction(relationshipDeleteTarget.id);
          } else if (relationshipDeleteTarget?.kind === 'plan') {
            void handleDeletePlan(relationshipDeleteTarget.id);
          }
        }}
      />

      <ConfirmDialog
        open={connectionDeleteTarget !== null}
        title={connectionDeleteTarget?.kind === 'relationship' ? 'Remove connection?' : 'Remove child?'}
        description={connectionDeleteTarget
          ? connectionDeleteTarget.kind === 'relationship'
            ? `Disconnect ${connectionDeleteTarget.label} from ${contact.name}. Both contact profiles will remain.`
            : `Remove ${connectionDeleteTarget.label} from ${contact.name}’s children list.`
          : ''}
        safetyNote={connectionDeleteTarget?.kind === 'relationship'
          ? 'This removes only the relationship link; it does not delete either contact.'
          : 'This removes only this child entry from the profile.'}
        safetyTone="irreversible"
        confirmLabel={connectionDeleteTarget?.kind === 'relationship' ? 'Remove connection' : 'Remove child'}
        pendingLabel="Removing..."
        pending={deletingConnection}
        onCancel={() => setConnectionDeleteTarget(null)}
        onConfirm={() => void handleDeleteConnection()}
      />

      {showReminderForm && (
        <Card className="animate-slide-down border-primary/20 bg-primary/5">
          <CardContent className="pt-5 pb-4">
            <form onSubmit={handleSetReminder} className="space-y-3">
              <div className="flex items-center gap-2 mb-1">
                <Bell className="w-4 h-4 text-primary" />
                <span className="font-medium text-sm">Set a reminder</span>
              </div>
              <Label htmlFor="reminder-title" className="sr-only">Reminder title</Label>
              <Input
                id="reminder-title"
                required
                placeholder="What to remember..."
                value={reminderForm.title}
                onChange={(e) => setReminderForm({ ...reminderForm, title: e.target.value })}
                className="bg-white"
              />
              <Label htmlFor="reminder-at" className="sr-only">Reminder date and time</Label>
              <Input
                id="reminder-at"
                type="datetime-local"
                required
                value={reminderForm.remind_at}
                onChange={(e) => setReminderForm({ ...reminderForm, remind_at: e.target.value })}
                className="bg-white"
              />
              <Label htmlFor="reminder-notes" className="sr-only">Reminder notes</Label>
              <Textarea
                id="reminder-notes"
                placeholder="Notes (optional)"
                value={reminderForm.notes}
                onChange={(e) => setReminderForm({ ...reminderForm, notes: e.target.value })}
                rows={2}
                className="bg-white"
              />
              <div className="flex gap-2">
                <Button type="submit" size="sm">Save reminder</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setShowReminderForm(false)}>Cancel</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <div id="profile-overview" className={`${mobileSection === 'overview' ? 'grid' : 'hidden md:grid'} grid-cols-1 items-start gap-4 sm:gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]`}>
        <Card className="border-0 shadow-sm animate-fade-in-up">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold">Relationship brief</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm font-semibold text-foreground">{brief?.headline || 'Relationship context is loading'}</p>
              <p className="text-sm text-muted-foreground mt-2">{brief?.summary}</p>
            </div>
            <div className="rounded-xl border border-border/60 bg-muted/30 p-4">
              <p className="text-xs font-medium text-muted-foreground">Next best step</p>
              <p className="text-sm mt-1 text-foreground">{brief?.nextStep}</p>
            </div>
            {brief?.talkingPoints && brief.talkingPoints.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">Talking points</p>
                <div className="flex flex-wrap gap-2">
                  {brief.talkingPoints.map((point) => (
                    <span key={point} className="px-3 py-1 text-xs rounded-full bg-muted text-muted-foreground">
                      {point}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {brief?.suggestedOutreach && brief.suggestedOutreach.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">Suggested outreach angles</p>
                <div className="space-y-2">
                  {brief.suggestedOutreach.map((entry) => (
                    <div key={entry} className="rounded-xl border border-border/60 bg-white/80 p-3 text-sm text-foreground">
                      {entry}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="min-w-0 space-y-4">
          {process.env.NEXT_PUBLIC_AUTH_MODE === 'google' && <PersonCalendarContext key={id} contactId={id} refreshKey={contact} />}
          {process.env.NEXT_PUBLIC_AUTH_MODE === 'google' && contact.public_id && <PersonGmailContext key={contact.public_id} personId={contact.public_id} refreshKey={contact} />}
          <Card className="border-0 shadow-sm animate-fade-in-up">
            <CardContent className="pt-5 pb-4">
              <div className="flex items-center gap-2">
                <CalendarClock className="h-4 w-4 text-primary" aria-hidden="true" />
                <h2 className="text-sm font-semibold">Check-in rhythm</h2>
              </div>
              <p className={`mt-3 text-base font-semibold ${rhythm.kind === 'ready' ? 'text-amber-900' : 'text-foreground'}`}>{rhythm.label}</p>
              <p className="mt-1 text-sm text-muted-foreground">{rhythm.detail}</p>
              <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">This is a reminder preference, not a measure of relationship quality.</p>
            </CardContent>
          </Card>

          <Card className="border-0 shadow-sm animate-fade-in-up">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold">
                Open reminders
                {history.reminders.total > 0 && (
                  <span className="ml-1.5 text-sm font-normal text-muted-foreground">
                    ({history.reminders.total})
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {openReminders.length > 0 ? (
                <>
                  {openReminders.map((reminder) => (
                    <div key={reminder.id} className="rounded-xl border border-border/60 bg-white/80 p-3">
                      <p className="font-medium text-sm">{reminder.title}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {new Date(reminder.remind_at).toLocaleString()}
                      </p>
                    </div>
                  ))}
                  {history.reminders.page < history.reminders.totalPages && (
                    <Button
                      variant="outline"
                      className="h-11 w-full sm:h-9"
                      disabled={loadingMore !== null}
                      onClick={() => loadMoreHistory('reminders')}
                    >
                      {loadingMore === 'reminders' ? 'Loading...' : 'Load more reminders'}
                    </Button>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">No open reminders for this relationship yet.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <nav id="profile-activity" aria-label="Activity filters" className={`${mobileSection === 'activity' ? 'flex' : 'hidden md:flex'} gap-2 overflow-x-auto pb-1`}>
        {ACTIVITY_FILTERS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            aria-pressed={activityFilter === value}
            onClick={() => setActivityFilter(value)}
            className={`min-h-10 shrink-0 rounded-full border px-4 text-sm font-semibold transition-colors ${activityFilter === value ? 'border-primary bg-primary text-white' : 'border-border bg-white text-muted-foreground hover:text-foreground'}`}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className={`${mobileSection === 'overview' ? 'hidden md:grid' : 'grid'} grid-cols-1 gap-4 sm:gap-6 xl:grid-cols-[1.4fr_1fr]`}>
        <Card className={`${activityFilter === 'interaction' ? 'hidden' : mobileSection === 'activity' ? '' : 'hidden md:block'} order-1 border-0 shadow-sm animate-fade-in-up`}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold">
              {ACTIVITY_FILTERS.find(({ value }) => value === activityFilter)?.label}
              {visibleTimelinePagination.total > 0 && (
                <span className="ml-1.5 text-sm font-normal text-muted-foreground">
                  ({visibleTimelinePagination.total})
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {filterError ? <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{filterError} <button type="button" className="font-semibold underline" onClick={() => setActivityRevision((value) => value + 1)}>Retry</button></div> : filterLoading && activityFilter !== 'all' ? <p role="status" className="text-sm text-muted-foreground">Loading activity...</p> : visibleTimeline.length > 0 ? (
              <>
                {visibleTimeline.map((item) => (
                  <div key={item.id} className="rounded-xl border border-border/60 bg-white/80 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium text-sm text-foreground">{item.title}</p>
                        <p className="text-sm text-muted-foreground mt-1">{item.summary}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${getTimelineToneClasses(item.tone)}`}>{item.kind}</span>
                        {item.kind === 'interaction' && (
                          <>
                            <Button type="button" variant="ghost" size="icon" className="h-10 w-10" disabled={loadingInteractionId !== null} onClick={() => void editFromTimeline(item)} aria-label={`Edit interaction: ${item.title}`}>
                              <Edit className="h-4 w-4" aria-hidden="true" />
                            </Button>
                            <Button type="button" variant="ghost" size="icon" className="h-10 w-10 text-muted-foreground hover:text-destructive" onClick={() => setRelationshipDeleteTarget({ kind: 'interaction', id: Number(item.id.slice('interaction-'.length)), label: item.title })} aria-label={`Delete interaction: ${item.title}`}>
                              <Trash2 className="h-4 w-4" aria-hidden="true" />
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-3">
                      {item.date.length === 10 ? formatDate(item.date) : new Date(item.date).toLocaleString()}
                    </p>
                  </div>
                ))}
                {visibleTimelinePagination.page < visibleTimelinePagination.totalPages && (
                  <Button
                    variant="outline"
                    className="h-11 w-full sm:h-9"
                    disabled={loadingMore !== null}
                    onClick={() => void loadMoreFilteredTimeline()}
                  >
                    {loadingMore === 'timeline' ? 'Loading...' : 'Load older activity'}
                  </Button>
                )}
              </>
            ) : (
              <div className="text-center py-10">
                <div className="text-3xl mb-2">🕰️</div>
                <p className="text-sm text-muted-foreground">{activityFilter === 'all' ? 'This timeline will fill up as you capture conversations, reminders, and context.' : 'Nothing in this activity filter yet.'}</p>
              </div>
            )}
          </CardContent>
        </Card>

        <div id="profile-details" className={`${mobileSection === 'details' ? 'space-y-4' : 'hidden md:block md:space-y-4'} order-2`}>
          {(tags.length > 0 || Object.keys(socialLinks).length > 0) && (
            <Card className="border-0 shadow-sm sm:hidden">
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold">Profile details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {tags.length > 0 && (
                  <div>
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Groups and tags</p>
                    <div className="flex flex-wrap gap-1.5">
                      {tags.map((tag) => (
                        <span key={tag} className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">{tag}</span>
                      ))}
                    </div>
                  </div>
                )}
                {Object.keys(socialLinks).length > 0 && (
                  <div>
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Links</p>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(socialLinks).map(([key, url]) => {
                        const config = socialIconMap[key];
                        if (!config) return null;
                        const SocialIcon = config.icon;
                        return (
                          <a key={key} href={url} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-medium text-foreground hover:border-primary/30 hover:text-primary">
                            <SocialIcon className="h-3.5 w-3.5" aria-hidden="true" />
                            {config.label}
                          </a>
                        );
                      })}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
          <Card className="border-0 shadow-sm animate-fade-in-up">
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Link2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  <CardTitle className="text-base font-semibold">Family & connections</CardTitle>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8"
                    onClick={() => {
                      setShowRelationshipForm((current) => !current);
                      setShowChildForm(false);
                    }}
                  >
                    <Link2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                    Connect
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8"
                    onClick={() => {
                      setShowChildForm((current) => !current);
                      setEditingChildId(null);
                      setChildForm({ name: '', birthday: '', linked_contact_id: '', linked_name: '', expected_updated_at: '' });
                      setChildSearch('');
                      setShowRelationshipForm(false);
                    }}
                  >
                    <Baby className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                    Child
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              {showRelationshipForm && (
                <form onSubmit={handleCreateRelationship} className="space-y-3 rounded-xl border border-border/60 bg-muted/30 p-3">
                  <div>
                    <Label htmlFor="relationship-contact" className="text-xs">Connect another contact</Label>
                    {relationshipForm.related_contact_id ? (
                      <div className="mt-1 flex min-h-10 items-center justify-between gap-3 rounded-lg border border-input bg-white px-3 py-2">
                        <span className="text-sm font-medium">{relationshipForm.related_name}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7"
                          onClick={() => setRelationshipForm({
                            ...relationshipForm,
                            related_contact_id: '',
                            related_name: '',
                          })}
                        >
                          Change
                        </Button>
                      </div>
                    ) : (
                      <div className="relative">
                        <Input
                          id="relationship-contact"
                          value={relationshipSearch}
                          onChange={(event) => setRelationshipSearch(event.target.value)}
                          placeholder="Search contacts"
                          autoComplete="off"
                          className="mt-1 bg-white"
                        />
                        {relationshipOptions.length > 0 && (
                          <div className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-border bg-white p-1 shadow-lg">
                            {relationshipOptions.map((option) => (
                              <button
                                key={option.id}
                                type="button"
                                className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left hover:bg-muted"
                                onClick={() => {
                                  setRelationshipForm({
                                    ...relationshipForm,
                                    related_contact_id: String(option.id),
                                    related_name: option.name,
                                  });
                                  setRelationshipSearch('');
                                }}
                              >
                                <span className="text-sm font-medium">{option.name}</span>
                                {option.email && <span className="truncate text-xs text-muted-foreground">{option.email}</span>}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <Label htmlFor="relationship-label" className="text-xs">Shown on this profile</Label>
                      <Input
                        id="relationship-label"
                        list="relationship-label-options"
                        maxLength={80}
                        value={relationshipForm.relationship_label}
                        onChange={(event) => setRelationshipForm({
                          ...relationshipForm,
                          relationship_label: event.target.value,
                        })}
                        placeholder="e.g. Wife"
                        className="mt-1 bg-white"
                      />
                    </div>
                    <div>
                      <Label htmlFor="reciprocal-label" className="text-xs">Shown on their profile</Label>
                      <Input
                        id="reciprocal-label"
                        list="relationship-label-options"
                        maxLength={80}
                        value={relationshipForm.reciprocal_label}
                        onChange={(event) => setRelationshipForm({
                          ...relationshipForm,
                          reciprocal_label: event.target.value,
                        })}
                        placeholder="e.g. Husband"
                        className="mt-1 bg-white"
                      />
                    </div>
                  </div>
                  <datalist id="relationship-label-options">
                    {RELATIONSHIP_LABEL_OPTIONS.map((label) => <option key={label} value={label} />)}
                  </datalist>
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={savingConnection || !relationshipForm.related_contact_id}>
                      {savingConnection ? 'Connecting...' : 'Connect contacts'}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" disabled={savingConnection} onClick={() => setShowRelationshipForm(false)}>
                      Cancel
                    </Button>
                  </div>
                </form>
              )}

              {showChildForm && (
                <form onSubmit={handleCreateChild} className="space-y-3 rounded-xl border border-border/60 bg-muted/30 p-3">
                  <p className="text-sm font-medium">{editingChildId === null ? 'Add a child' : 'Edit child'}</p>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <Label htmlFor="child-name" className="text-xs">Child name</Label>
                      <Input
                        id="child-name"
                        required
                        maxLength={200}
                        disabled={!!childForm.linked_contact_id}
                        value={childForm.name}
                        onChange={(event) => setChildForm({ ...childForm, name: event.target.value })}
                        placeholder="Name"
                        className="mt-1 bg-white"
                      />
                    </div>
                    <div>
                      <Label htmlFor="child-birthday" className="text-xs">Birthday</Label>
                      <Input
                        id="child-birthday"
                        type="date"
                        disabled={!!childForm.linked_contact_id}
                        value={childForm.birthday}
                        onChange={(event) => setChildForm({ ...childForm, birthday: event.target.value })}
                        className="mt-1 bg-white"
                      />
                    </div>
                  </div>
                  <div>
                    <Label htmlFor="child-contact-search" className="text-xs">Link to an existing contact (optional)</Label>
                    {childForm.linked_contact_id ? (
                      <div className="mt-1 flex flex-wrap items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm">
                        <Link href={`/contacts/${childForm.linked_contact_id}`} className="font-medium text-primary hover:underline">
                          {childForm.linked_name}
                        </Link>
                        <span className="text-xs text-muted-foreground">Name and birthday come from this profile.</span>
                        <Button type="button" variant="ghost" size="sm" disabled={savingConnection} onClick={() => setChildForm((current) => ({
                          ...current,
                          name: current.linked_name,
                          birthday: editingChildId === null
                            ? current.birthday
                            : children.find((child) => child.id === editingChildId)?.linked_birthday || current.birthday,
                          linked_contact_id: '',
                          linked_name: '',
                        }))}>Unlink</Button>
                      </div>
                    ) : (
                      <>
                        <Input
                          id="child-contact-search"
                          value={childSearch}
                          onChange={(event) => setChildSearch(event.target.value)}
                          placeholder="Search existing profiles"
                          autoComplete="off"
                          className="mt-1 bg-white"
                        />
                        {childSearch.trim() && childOptions.length > 0 && (
                          <div className="mt-1 max-h-40 overflow-y-auto rounded-lg border bg-white p-1" role="listbox" aria-label="Matching contacts">
                            {childOptions.map((option) => (
                              <button key={option.id} type="button" role="option" aria-selected="false"
                                className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted focus:bg-muted"
                                onClick={() => {
                                  setChildForm((current) => ({ ...current, name: option.name, linked_contact_id: String(option.id), linked_name: option.name }));
                                  setChildSearch('');
                                }}>
                                {option.name}{option.email ? ` · ${option.email}` : ''}
                              </button>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">If this child already has a profile, linking it prevents duplicate birthday alerts. Any saved birthday must match that profile.</p>
                  </div>
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={savingConnection || !childForm.name.trim()}>
                      {savingConnection ? 'Saving...' : editingChildId === null ? 'Add child' : 'Save changes'}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" disabled={savingConnection} onClick={() => {
                      setShowChildForm(false);
                      setEditingChildId(null);
                      setChildForm({ name: '', birthday: '', linked_contact_id: '', linked_name: '', expected_updated_at: '' });
                    }}>
                      Cancel
                    </Button>
                  </div>
                </form>
              )}

              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Connected profiles ({connections.relationships.total})
                </p>
                {relationships.length > 0 ? relationships.map((relationship) => (
                  <div key={relationship.id} className="group flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-white/80 p-3">
                    <Link href={`/contacts/${relationship.related_contact_id}`} className="min-w-0 flex-1 hover:text-primary">
                      <p className="truncate text-sm font-medium">{relationship.related_name}</p>
                      {relationship.related_nickname && (
                        <p className="truncate text-xs text-muted-foreground">Goes by {relationship.related_nickname}</p>
                      )}
                    </Link>
                    <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
                      {relationship.relationship_label}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:bg-red-50 hover:text-destructive sm:opacity-0 sm:group-hover:opacity-100"
                      aria-label={`Remove connection to ${relationship.related_name}`}
                      onClick={() => setConnectionDeleteTarget({
                        kind: 'relationship',
                        id: relationship.id,
                        label: relationship.related_name,
                      })}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                )) : (
                  <p className="text-sm text-muted-foreground">No connected contact profiles yet.</p>
                )}
                {connections.relationships.page < connections.relationships.totalPages && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full"
                    disabled={loadingMoreConnections !== null}
                    onClick={() => void loadMoreConnectionRecords('relationships')}
                  >
                    {loadingMoreConnections === 'relationships' ? 'Loading...' : 'Load more connections'}
                  </Button>
                )}
              </div>

              <div className="space-y-2 border-t border-border/50 pt-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Children ({connections.children.total})
                </p>
                {children.length > 0 ? children.map((child) => (
                  <div key={child.id} className="group flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-white/80 p-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div className="rounded-lg bg-amber-50 p-2 text-amber-700">
                        <Baby className="h-4 w-4" aria-hidden="true" />
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {child.linked_contact_id ? (
                            <Link href={`/contacts/${child.linked_contact_id}`} className="hover:text-primary hover:underline">
                              {child.linked_name || child.name}
                            </Link>
                          ) : child.name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {(child.linked_contact_id ? child.linked_birthday : child.birthday)
                            ? formatDate((child.linked_contact_id ? child.linked_birthday : child.birthday)!)
                            : child.linked_contact_id ? 'Add birthday on linked profile' : 'Birthday not added'}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary"
                        aria-label={`Edit child ${child.linked_name || child.name}`}
                        onClick={() => {
                          setEditingChildId(child.id);
                          setChildForm({
                            name: child.linked_name || child.name,
                            birthday: child.birthday || '',
                            linked_contact_id: child.linked_contact_id ? String(child.linked_contact_id) : '',
                            linked_name: child.linked_name || child.name,
                            expected_updated_at: child.updated_at,
                          });
                          setChildSearch('');
                          setShowRelationshipForm(false);
                          setShowChildForm(true);
                        }}>
                        <Edit className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                      <Button type="button" variant="ghost" size="icon"
                        className="h-8 w-8 text-muted-foreground hover:bg-red-50 hover:text-destructive"
                        aria-label={`Remove child ${child.linked_name || child.name}`}
                        onClick={() => setConnectionDeleteTarget({ kind: 'child', id: child.id, label: child.linked_name || child.name })}>
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                )) : (
                  <p className="text-sm text-muted-foreground">No children added yet.</p>
                )}
                {connections.children.page < connections.children.totalPages && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full"
                    disabled={loadingMoreConnections !== null}
                    onClick={() => void loadMoreConnectionRecords('children')}
                  >
                    {loadingMoreConnections === 'children' ? 'Loading...' : 'Load more children'}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {(contact.how_we_met || contact.notes || facts.length > 0 || giftIdeas.length > 0) && (
            <Card className="border-0 shadow-sm animate-fade-in-up">
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold">Relationship memory</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {contact.how_we_met && (
                  <div>
                    <div className="flex items-center gap-1.5 mb-1">
                      <MapPin className="w-3.5 h-3.5 text-muted-foreground" />
                      <span className="text-xs font-medium text-muted-foreground">How you met</span>
                    </div>
                    <MentionText text={contact.how_we_met} className="text-sm text-foreground" />
                  </div>
                )}

                {facts.length > 0 && (
                  <div>
                    <div className="flex items-center gap-1.5 mb-2">
                      <StickyNote className="w-3.5 h-3.5 text-muted-foreground" />
                      <span className="text-xs font-medium text-muted-foreground">
                        Structured facts ({history.facts.total})
                      </span>
                    </div>
                    <div className="space-y-2">
                      {facts.map((fact) => (
                        <div key={fact.id} className="rounded-xl border border-border/60 bg-muted/30 p-3">
                          <p className="text-sm font-medium">{fact.label}</p>
                          <p className="text-xs text-muted-foreground mt-1">{fact.value || fact.source}</p>
                        </div>
                      ))}
                      {history.facts.page < history.facts.totalPages && (
                        <Button
                          variant="outline"
                          className="h-11 w-full sm:h-9"
                          disabled={loadingMore !== null}
                          onClick={() => loadMoreHistory('facts')}
                        >
                          {loadingMore === 'facts' ? 'Loading...' : 'Load more facts'}
                        </Button>
                      )}
                    </div>
                  </div>
                )}

                {giftIdeas.length > 0 && (
                  <div>
                    <div className="flex items-center gap-1.5 mb-2">
                      <Gift className="w-3.5 h-3.5 text-muted-foreground" />
                      <span className="text-xs font-medium text-muted-foreground">Gift ideas</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {giftIdeas.map((idea) => (
                        <span key={idea} className="px-3 py-1 text-xs rounded-full bg-amber-50 text-amber-700 border border-amber-200/50">
                          {idea}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {contact.notes && (
                  <div>
                    <div className="flex items-center gap-1.5 mb-1">
                      <StickyNote className="w-3.5 h-3.5 text-muted-foreground" />
                      <span className="text-xs font-medium text-muted-foreground">Notes</span>
                    </div>
                    <MentionText text={contact.notes} className="text-sm text-foreground whitespace-pre-wrap" />
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      <Card ref={interactionLogRef} className={`${activityFilter !== 'interaction' ? 'hidden' : mobileSection === 'activity' ? '' : 'hidden md:block'} order-1 animate-fade-in-up scroll-mt-28 border-0 shadow-sm`}>
        <CardHeader className="pb-3">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-muted-foreground" />
              <CardTitle className="text-base font-semibold">
                Conversations
                {history.interactions.total > 0 && (
                  <span className="text-muted-foreground font-normal ml-1.5 text-sm">({history.interactions.total})</span>
                )}
              </CardTitle>
            </div>
            <Button size="sm" onClick={() => setShowLogForm(!showLogForm)} className="h-11 shadow-sm sm:h-8" aria-controls="interaction-form" aria-expanded={showLogForm}>
              <Plus className="w-3.5 h-3.5 mr-1.5" />
              Log
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-xs leading-relaxed text-muted-foreground">A focused view of your conversations. Edit or remove a moment here without losing the rest of the relationship history.</p>
          {showLogForm && (
            <form id="interaction-form" onSubmit={handleLogInteraction} className="animate-slide-down space-y-3 mb-6 p-4 rounded-xl bg-muted/40 border border-border/50">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="interaction-type" className="text-xs">Type</Label>
                  <select
                    id="interaction-type"
                    className="w-full h-9 rounded-lg border border-input bg-white px-3 py-1 text-sm mt-1"
                    value={interactionForm.type}
                    onChange={(e) => setInteractionForm({ ...interactionForm, type: e.target.value })}
                  >
                    <option value="call">📞 Call</option>
                    <option value="message">💬 Message</option>
                    <option value="meetup">☕ Meetup</option>
                    <option value="email">✉️ Email</option>
                  </select>
                </div>
                <div>
                  <Label htmlFor="interaction-date" className="text-xs">Date</Label>
                  <Input
                    id="interaction-date"
                    type="date"
                    value={interactionForm.date}
                    onChange={(e) => setInteractionForm({ ...interactionForm, date: e.target.value })}
                    className="mt-1 bg-white"
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="interaction-summary" className="text-xs">Summary</Label>
                <Input
                  id="interaction-summary"
                  placeholder="What happened?"
                  value={interactionForm.summary}
                  onChange={(e) => setInteractionForm({ ...interactionForm, summary: e.target.value })}
                  className="mt-1 bg-white"
                />
              </div>
              <div>
                <Label htmlFor="interaction-notes" className="text-xs">Notes</Label>
                <MentionInput
                  id="interaction-notes"
                  placeholder="Any details to remember... (type @ to mention a contact)"
                  value={interactionForm.notes}
                  onChange={(val) => setInteractionForm({ ...interactionForm, notes: val })}
                  rows={2}
                  className="mt-1 bg-white"
                />
              </div>
              <div className="flex gap-2">
                <Button type="submit" size="sm">Save</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setShowLogForm(false)}>Cancel</Button>
              </div>
            </form>
          )}

          <div className="space-y-0">
            {interactions.length === 0 ? (
              <div className="text-center py-10">
                <div className="text-3xl mb-2">💬</div>
                <p className="text-sm text-muted-foreground">No interactions yet</p>
                <p className="text-xs text-muted-foreground mt-0.5">Log your first conversation above</p>
              </div>
            ) : (
              interactions.map((interaction, index) => {
                const config = interactionTypeConfig[interaction.type] || interactionTypeConfig.call;
                const Icon = config.icon;
                const isEditing = editingInteractionId === interaction.id;
                const interactionLabel = interaction.summary || `${interaction.type} on ${formatDate(interaction.date)}`;
                return (
                  <div key={interaction.id} className="flex gap-3 group">
                    <div className="flex flex-col items-center">
                      <div className={`w-8 h-8 rounded-full ${config.bg} flex items-center justify-center flex-shrink-0`}>
                        <Icon className={`w-3.5 h-3.5 ${config.color}`} />
                      </div>
                      {index < interactions.length - 1 && <div className="w-px flex-1 bg-border my-1" />}
                    </div>
                    <div className={`flex-1 pb-5 ${index < interactions.length - 1 ? '' : 'pb-0'}`}>
                      {isEditing ? (
                        <form id={`interaction-edit-${interaction.id}`} onSubmit={handleEditInteraction} className="animate-slide-down scroll-mt-28 space-y-3 rounded-xl border border-border/50 bg-muted/40 p-3">
                          {interactionEditConflict && (
                            <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                              <p className="font-medium">This interaction changed somewhere else.</p>
                              <p className="mt-1 text-amber-900">Your draft is still here and was not overwritten.</p>
                              <div className="mt-2 flex flex-wrap gap-2">
                                <Link
                                  href={`/contacts/${id}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                                >
                                  Open latest in a new tab
                                </Link>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    setEditingInteractionId(null);
                                    setInteractionEditConflict(false);
                                    void refreshContact();
                                  }}
                                >
                                  Discard draft and refresh
                                </Button>
                              </div>
                            </div>
                          )}
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <Label htmlFor="edit-interaction-type" className="text-xs">Type</Label>
                              <select
                                id="edit-interaction-type"
                                className="w-full h-9 rounded-lg border border-input bg-white px-3 py-1 text-sm mt-1"
                                value={editInteractionForm.type}
                                onChange={(e) => setEditInteractionForm({ ...editInteractionForm, type: e.target.value })}
                              >
                                <option value="call">📞 Call</option>
                                <option value="message">💬 Message</option>
                                <option value="meetup">☕ Meetup</option>
                                <option value="email">✉️ Email</option>
                              </select>
                            </div>
                            <div>
                              <Label htmlFor="edit-interaction-date" className="text-xs">Date</Label>
                              <Input
                                id="edit-interaction-date"
                                type="date"
                                value={editInteractionForm.date}
                                onChange={(e) => setEditInteractionForm({ ...editInteractionForm, date: e.target.value })}
                                className="mt-1 bg-white"
                              />
                            </div>
                          </div>
                          <div>
                            <Label htmlFor="edit-interaction-summary" className="text-xs">Summary</Label>
                            <Input
                              id="edit-interaction-summary"
                              placeholder="What happened?"
                              value={editInteractionForm.summary}
                              onChange={(e) => setEditInteractionForm({ ...editInteractionForm, summary: e.target.value })}
                              className="mt-1 bg-white"
                            />
                          </div>
                          <div>
                            <Label htmlFor="edit-interaction-notes" className="text-xs">Notes</Label>
                            <MentionInput
                              id="edit-interaction-notes"
                              placeholder="Any details to remember... (type @ to mention a contact)"
                              value={editInteractionForm.notes}
                              onChange={(val) => setEditInteractionForm({ ...editInteractionForm, notes: val })}
                              rows={2}
                              className="mt-1 bg-white"
                            />
                          </div>
                          <div className="flex gap-2">
                            <Button type="submit" size="sm">Save</Button>
                            <Button type="button" variant="ghost" size="sm" onClick={() => {
                              setEditingInteractionId(null);
                              setInteractionEditConflict(false);
                            }}>Cancel</Button>
                          </div>
                        </form>
                      ) : (
                        <div className="flex items-start gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-baseline gap-2">
                              <span className="font-medium text-sm capitalize">{interaction.type}</span>
                              <span className="text-xs text-muted-foreground">{formatDate(interaction.date)}</span>
                            </div>
                            {interaction.summary && (
                              <p className="text-sm text-foreground mt-0.5"><MentionText text={interaction.summary} /></p>
                            )}
                            {interaction.notes && (
                              <p className="text-xs text-muted-foreground mt-1"><MentionText text={interaction.notes} /></p>
                            )}
                          </div>
                          <div className="sm:opacity-0 sm:group-hover:opacity-100 transition-opacity flex gap-1 flex-shrink-0 pt-0.5">
                            <Button
                              onClick={() => startEditInteraction(interaction)}
                              variant="ghost"
                              size="icon"
                              className="h-11 w-11 rounded-full sm:h-8 sm:w-8"
                              type="button"
                              aria-label={`Edit interaction: ${interactionLabel}`}
                            >
                              <Edit className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                            </Button>
                            <Button
                              onClick={() => setRelationshipDeleteTarget({
                                kind: 'interaction',
                                id: interaction.id,
                                label: interaction.summary || `${interaction.type} on ${formatDate(interaction.date)}`,
                              })}
                              variant="ghost"
                              size="icon"
                              className="h-11 w-11 rounded-full hover:bg-red-50 hover:text-destructive sm:h-8 sm:w-8"
                              type="button"
                              aria-label={`Delete interaction: ${interactionLabel}`}
                            >
                              <Trash2 className="h-4 w-4" aria-hidden="true" />
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
            {history.interactions.page < history.interactions.totalPages && (
              <Button
                variant="outline"
                className="mb-1 mt-4 h-11 w-full sm:h-9"
                disabled={loadingMore !== null}
                onClick={() => loadMoreHistory('interactions')}
              >
                {loadingMore === 'interactions' ? 'Loading...' : 'Load older interactions'}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
      </div>

      <Card className={`${mobileSection === 'overview' ? '' : 'hidden md:block'} animate-fade-in-up border-0 shadow-sm`}>
        <CardHeader className="pb-3">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-2">
              <CalendarClock className="w-4 h-4 text-muted-foreground" />
              <CardTitle className="text-base font-semibold">
                Plans
                {history.plans.total > 0 && (
                  <span className="text-muted-foreground font-normal ml-1.5 text-sm">({history.plans.total})</span>
                )}
              </CardTitle>
            </div>
            <Button size="sm" onClick={() => setShowPlanForm(!showPlanForm)} className="h-11 shadow-sm sm:h-8">
              <Plus className="w-3.5 h-3.5 mr-1.5" />
              Plan
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {showPlanForm && (
            <form onSubmit={handleCreatePlan} className="animate-slide-down space-y-3 mb-6 p-4 rounded-xl bg-muted/40 border border-border/50">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="plan-type" className="text-xs">Type</Label>
                  <select
                    id="plan-type"
                    className="w-full h-9 rounded-lg border border-input bg-white px-3 py-1 text-sm mt-1"
                    value={planForm.type}
                    onChange={(e) => setPlanForm({ ...planForm, type: e.target.value })}
                  >
                    <option value="call">📞 Call</option>
                    <option value="message">💬 Message</option>
                    <option value="meetup">☕ Meetup</option>
                    <option value="email">✉️ Email</option>
                  </select>
                </div>
                <div>
                  <Label htmlFor="plan-date" className="text-xs">Date</Label>
                  <Input
                    id="plan-date"
                    type="date"
                    required
                    value={planForm.planned_date}
                    onChange={(e) => setPlanForm({ ...planForm, planned_date: e.target.value })}
                    className="mt-1 bg-white"
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="plan-summary" className="text-xs">What&apos;s the plan?</Label>
                <Input
                  id="plan-summary"
                  placeholder="Catch up over coffee, discuss project..."
                  value={planForm.summary}
                  onChange={(e) => setPlanForm({ ...planForm, summary: e.target.value })}
                  className="mt-1 bg-white"
                />
              </div>
              <div>
                <Label htmlFor="plan-notes" className="text-xs">Notes</Label>
                <MentionInput
                  id="plan-notes"
                  placeholder="Anything to prepare or remember... (type @ to mention a contact)"
                  value={planForm.notes}
                  onChange={(val) => setPlanForm({ ...planForm, notes: val })}
                  rows={2}
                  className="mt-1 bg-white"
                />
              </div>
              <div className="flex gap-2">
                <Button type="submit" size="sm">Schedule</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setShowPlanForm(false)}>Cancel</Button>
              </div>
            </form>
          )}

          {openPlans.length > 0 ? (
            <div className="space-y-2">
              {openPlans.map((plan) => {
                const config = interactionTypeConfig[plan.type] || interactionTypeConfig.call;
                const Icon = config.icon;
                const isOverdue = new Date(plan.planned_date) < new Date(new Date().toISOString().split('T')[0]);
                const planLabel = plan.summary || `${plan.type} on ${formatDate(plan.planned_date)}`;
                return (
                  <div key={plan.id} className={`flex items-start gap-3 p-3 rounded-xl border group ${
                    isOverdue ? 'border-rose-200/60 bg-rose-50/50' : 'border-border/60 bg-white/80'
                  }`}>
                    <div className={`w-8 h-8 rounded-full ${config.bg} flex items-center justify-center flex-shrink-0 mt-0.5`}>
                      <Icon className={`w-3.5 h-3.5 ${config.color}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span className="font-medium text-sm capitalize">{plan.type}</span>
                        <span className={`text-xs ${isOverdue ? 'text-rose-600 font-medium' : 'text-muted-foreground'}`}>
                          {isOverdue ? 'Overdue · ' : ''}{formatDate(plan.planned_date)}
                        </span>
                      </div>
                      {plan.summary && <p className="text-sm text-foreground mt-0.5"><MentionText text={plan.summary} /></p>}
                      {plan.notes && <p className="text-xs text-muted-foreground mt-1"><MentionText text={plan.notes} /></p>}
                    </div>
                    <div className="sm:opacity-0 sm:group-hover:opacity-100 transition-opacity flex gap-1 flex-shrink-0 pt-0.5">
                      <Button
                        onClick={() => handleCompletePlan(plan.id)}
                        variant="ghost"
                        size="icon"
                        className="h-11 w-11 rounded-full hover:bg-emerald-50 sm:h-8 sm:w-8"
                        title="Mark as done"
                        aria-label={`Mark plan as done: ${planLabel}`}
                        type="button"
                      >
                        <Check className="h-4 w-4 text-emerald-600" aria-hidden="true" />
                      </Button>
                      <Button
                        onClick={() => setRelationshipDeleteTarget({
                          kind: 'plan',
                          id: plan.id,
                          label: plan.summary || `${plan.type} on ${formatDate(plan.planned_date)}`,
                        })}
                        variant="ghost"
                        size="icon"
                        className="h-11 w-11 rounded-full hover:bg-red-50 hover:text-destructive sm:h-8 sm:w-8"
                        type="button"
                        aria-label={`Delete plan: ${planLabel}`}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                );
              })}
              {history.plans.page < history.plans.totalPages && (
                <Button
                  variant="outline"
                  className="h-11 w-full sm:h-9"
                  disabled={loadingMore !== null}
                  onClick={() => loadMoreHistory('plans')}
                >
                  {loadingMore === 'plans' ? 'Loading...' : 'Load more plans'}
                </Button>
              )}
            </div>
          ) : (
            <div className="text-center py-8">
              <div className="text-3xl mb-2">📅</div>
              <p className="text-sm text-muted-foreground">No upcoming plans</p>
              <p className="text-xs text-muted-foreground mt-0.5">Schedule your next interaction above</p>
            </div>
          )}
        </CardContent>
      </Card>

    </div>
  );
}
