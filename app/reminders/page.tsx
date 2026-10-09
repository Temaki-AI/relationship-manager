'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { BellOff, BellRing, Check, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { getResponseErrorMessage } from '@/lib/utils';
import { useToast } from '@/components/ui/toast';
import { useReminderNotifications } from '@/components/reminder-notification-provider';
import { ReminderEmailSettings } from '@/components/reminder-email-settings';

type Reminder = {
  id: number;
  contact_id: number;
  contact_name: string;
  title: string;
  notes: string | null;
  remind_at: string;
};

type ReminderPagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

const initialPagination: ReminderPagination = {
  page: 1,
  pageSize: 50,
  total: 0,
  totalPages: 1,
};

function classifyReminder(remindAt: string): 'overdue' | 'today' | 'upcoming' {
  const remindDate = new Date(remindAt);
  const now = new Date();
  if (remindDate.toDateString() === now.toDateString()) return 'today';
  if (remindDate < now) return 'overdue';
  return 'upcoming';
}

function formatReminderDate(remindAt: string): string {
  const date = new Date(remindAt);
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function SkeletonReminders() {
  return (
    <div className="space-y-6">
      <div className="skeleton h-9 w-40" />
      {[1, 2, 3, 4].map(i => (
        <div key={i} className="skeleton h-16 rounded-xl" />
      ))}
    </div>
  );
}

export default function RemindersPage() {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [pagination, setPagination] = useState<ReminderPagination>(initialPagination);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<Reminder | null>(null);
  const [deletingReminder, setDeletingReminder] = useState(false);
  const { toast } = useToast();
  const notifications = useReminderNotifications();

  useEffect(() => {
    let cancelled = false;

    async function fetchReminders() {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await fetch(`/api/reminders?page=${page}&pageSize=50`, { cache: 'no-store' });
        if (!res.ok) {
          throw new Error(await getResponseErrorMessage(res, 'Failed to load reminders'));
        }
        const data = await res.json();
        if (!cancelled) {
          setReminders(Array.isArray(data.reminders) ? data.reminders : []);
          if (data.pagination) {
            setPagination(data.pagination);
            if (data.pagination.page !== page) setPage(data.pagination.page);
          }
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : 'Failed to load reminders');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchReminders();
    return () => { cancelled = true; };
  }, [page, refreshToken]);

  async function handleEnableNotifications() {
    const nextStatus = await notifications.enable();
    if (nextStatus === 'enabled') {
      toast({ message: 'Browser reminder alerts enabled' });
    } else if (nextStatus === 'denied') {
      toast({ message: 'Notifications are blocked in this browser’s site settings', variant: 'info' });
    } else if (nextStatus === 'unsupported') {
      toast({ message: 'Browser alerts are not supported in this context', variant: 'info' });
    } else if (nextStatus === 'unavailable') {
      toast({ message: 'Sign in again to verify this account before enabling alerts', variant: 'info' });
    }
  }

  async function handleComplete(id: number) {
    try {
      const res = await fetch(`/api/reminders/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed: true }),
      });
      if (!res.ok) {
        toast({ message: await getResponseErrorMessage(res, 'Failed to complete reminder'), variant: 'error' });
        return;
      }
      const result = await res.json() as { completionChanged?: boolean };
      setReminders(prev => prev.filter(r => r.id !== id));
      setRefreshToken((value) => value + 1);
      toast({ message: result.completionChanged === false ? 'Reminder was already completed' : 'Reminder completed' });
    } catch (error) {
      console.error('Failed to complete reminder:', error);
      toast({ message: 'Failed to complete reminder', variant: 'error' });
    }
  }

  async function handleDelete(id: number) {
    setDeletingReminder(true);
    try {
      const res = await fetch(`/api/reminders/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        toast({ message: await getResponseErrorMessage(res, 'Failed to delete reminder'), variant: 'error' });
        return;
      }
      const result = await res.json() as { alreadyDeleted?: boolean };
      setReminders(prev => prev.filter(r => r.id !== id));
      setRefreshToken((value) => value + 1);
      setDeleteTarget(null);
      toast({ message: result.alreadyDeleted ? 'Reminder was already deleted' : 'Reminder deleted' });
    } catch (error) {
      console.error('Failed to delete reminder:', error);
      toast({ message: 'Failed to delete reminder', variant: 'error' });
    } finally {
      setDeletingReminder(false);
    }
  }

  if (loading) return <SkeletonReminders />;

  const overdue = reminders.filter(r => classifyReminder(r.remind_at) === 'overdue');
  const today = reminders.filter(r => classifyReminder(r.remind_at) === 'today');
  const upcoming = reminders.filter(r => classifyReminder(r.remind_at) === 'upcoming');

  const sections = [
    { label: 'Overdue', items: overdue, dotColor: 'bg-red-400', bgColor: 'bg-danger-soft hover:bg-red-100/70', dotPulse: true },
    { label: 'Today', items: today, dotColor: 'bg-amber-400', bgColor: 'bg-warning-soft hover:bg-amber-100/70', dotPulse: false },
    { label: 'Upcoming', items: upcoming, dotColor: 'bg-blue-400', bgColor: 'hover:bg-muted/50', dotPulse: false },
  ];
  const rangeStart = pagination.total === 0
    ? 0
    : (pagination.page - 1) * pagination.pageSize + 1;
  const rangeEnd = rangeStart + reminders.length - 1;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="animate-fade-in">
        <h1 className="text-2xl sm:text-3xl font-bold">Reminders</h1>
        <p className="text-sm text-muted-foreground mt-0.5" aria-live="polite">
          {pagination.total} pending {pagination.total === 1 ? 'reminder' : 'reminders'}
          {pagination.total > 0 && ` · Showing ${rangeStart}-${rangeEnd}`}
        </p>
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete reminder?"
        description={deleteTarget
          ? `Remove “${deleteTarget.title}” for ${deleteTarget.contact_name}.`
          : ''}
        safetyNote="This reminder deletion cannot be undone. The contact and their relationship history will remain."
        safetyTone="irreversible"
        confirmLabel="Delete reminder"
        pendingLabel="Deleting..."
        pending={deletingReminder}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) void handleDelete(deleteTarget.id);
        }}
      />

      <Card className="overflow-hidden border-border/70 shadow-card animate-fade-in-up">
        <div className="h-1 bg-gradient-to-r from-blue-400 via-rose-400 to-amber-400" />
        <CardContent className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className={`rounded-xl p-2.5 ${
              notifications.status === 'enabled'
                ? 'bg-success-soft text-emerald-600'
                : 'bg-muted text-muted-foreground'
            }`}>
              {notifications.status === 'enabled'
                ? <BellRing className="h-5 w-5" aria-hidden="true" />
                : <BellOff className="h-5 w-5" aria-hidden="true" />}
            </div>
            <div>
              <h2 className="text-sm font-semibold">Browser alerts</h2>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                {notifications.status === 'denied'
                  ? 'Notifications are blocked for this site. Use your browser’s site settings to allow them.'
                  : notifications.status === 'unavailable'
                    ? 'Sign in again to verify this account before using browser alerts.'
                  : notifications.status === 'unsupported'
                    ? 'This browser or connection cannot show notification alerts. Your in-app reminder list still works.'
                    : 'Everclose CRM checks for due relationship reminders and birthday alerts while it is open in this browser. Delivery after the app is closed is not guaranteed.'}
              </p>
              <p className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
                Notification previews never include contact names, titles, or notes.
              </p>
            </div>
          </div>
          {notifications.status === 'disabled' && (
            <Button className="h-11 sm:h-9 sm:flex-shrink-0" onClick={handleEnableNotifications}>
              Enable browser alerts
            </Button>
          )}
          {notifications.status === 'enabled' && (
            <Button
              variant="outline"
              className="h-11 sm:h-9 sm:flex-shrink-0"
              onClick={() => {
                notifications.disable();
                toast({ message: 'Browser alerts turned off', variant: 'info' });
              }}
            >
              Turn off alerts
            </Button>
          )}
        </CardContent>
      </Card>

      {process.env.NEXT_PUBLIC_AUTH_MODE === 'google' && <ReminderEmailSettings />}

      {loadError && (
        <Card className="border border-amber-200/70 bg-warning-soft/40 shadow-sm">
          <CardContent className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold">Reminders could not be loaded</p>
              <p className="mt-1 text-sm text-muted-foreground">{loadError}</p>
            </div>
            <Button variant="secondary" onClick={() => setRefreshToken((value) => value + 1)}>
              Try again
            </Button>
          </CardContent>
        </Card>
      )}

      {!loadError && reminders.length > 0 ? (
        <div className="space-y-6 animate-fade-in-up">
          {sections.map((section) => {
            if (section.items.length === 0) return null;
            return (
              <div key={section.label}>
                <div className="flex items-center gap-2 mb-3">
                  <div className={`w-2.5 h-2.5 rounded-full ${section.dotColor} ${section.dotPulse ? 'animate-pulse-gentle' : ''}`} />
                  <h2 className="text-sm font-semibold text-muted-foreground">{section.label}</h2>
                  <span className="text-xs text-muted-foreground">({section.items.length})</span>
                </div>
                <div className="space-y-2">
                  {section.items.map((reminder) => (
                    <Card key={reminder.id} className="border-border/70 shadow-card">
                      <CardContent className={`py-3 px-4 rounded-xl ${section.bgColor} transition-colors`}>
                        <div className="flex items-start gap-3">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => handleComplete(reminder.id)}
                            className={`mt-0.5 h-11 w-11 rounded-full border-2 flex-shrink-0 sm:h-8 sm:w-8 ${
                              section.label === 'Overdue'
                                ? 'border-red-300 hover:bg-red-200 hover:border-red-400'
                                : section.label === 'Today'
                                ? 'border-amber-300 hover:bg-amber-200 hover:border-amber-400'
                                : 'border-blue-300 hover:bg-blue-200 hover:border-blue-400'
                            }`}
                            title="Mark as complete"
                            aria-label={`Mark ${reminder.title} as complete`}
                          >
                            <Check className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                          </Button>

                          {/* Content */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-baseline gap-2">
                              <Link
                                href={`/contacts/${reminder.contact_id}`}
                                className="font-medium text-sm hover:text-primary transition-colors"
                              >
                                {reminder.contact_name}
                              </Link>
                            </div>
                            <p className="text-sm text-foreground mt-0.5">{reminder.title}</p>
                            {reminder.notes && (
                              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{reminder.notes}</p>
                            )}
                            <p className="text-[10px] text-muted-foreground mt-1">
                              {formatReminderDate(reminder.remind_at)}
                            </p>
                          </div>

                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => setDeleteTarget(reminder)}
                            className="h-11 w-11 flex-shrink-0 rounded-full hover:bg-red-100 hover:text-destructive sm:h-8 sm:w-8"
                            title="Delete reminder"
                            aria-label={`Delete ${reminder.title}`}
                          >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            );
          })}
          {pagination.totalPages > 1 && (
            <div className="flex flex-col gap-3 border-t border-border/60 pt-5 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground" aria-live="polite">
                Page {pagination.page} of {pagination.totalPages} · {rangeStart}-{rangeEnd} of {pagination.total}
              </p>
              <div className="grid grid-cols-2 gap-2 sm:flex">
                <Button
                  variant="outline"
                  className="h-11 sm:h-9"
                  disabled={pagination.page <= 1}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  className="h-11 sm:h-9"
                  disabled={pagination.page >= pagination.totalPages}
                  onClick={() => setPage((value) => Math.min(pagination.totalPages, value + 1))}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : !loadError ? (
        <Card className="animate-scale-in border-border/70 shadow-card">
          <CardContent className="py-16 text-center">
            <div className="text-5xl mb-4">🔔</div>
            <h3 className="text-lg font-semibold">No pending reminders</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
              Set reminders from any contact&apos;s page to get nudged when it&apos;s time to reach out.
            </p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
