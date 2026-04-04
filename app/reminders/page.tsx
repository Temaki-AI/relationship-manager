'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Bell, Check, Trash2 } from 'lucide-react';

type Reminder = {
  id: number;
  contact_id: number;
  contact_name: string;
  title: string;
  notes: string | null;
  remind_at: string;
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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchReminders() {
      try {
        const res = await fetch('/api/reminders');
        const data = await res.json();
        setReminders(data.reminders || []);
      } catch (error) {
        console.error('Failed to fetch reminders:', error);
      } finally {
        setLoading(false);
      }
    }
    fetchReminders();
  }, []);

  async function handleComplete(id: number) {
    try {
      await fetch(`/api/reminders/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed: true }),
      });
      setReminders(prev => prev.filter(r => r.id !== id));
    } catch (error) {
      console.error('Failed to complete reminder:', error);
    }
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this reminder?')) return;
    try {
      await fetch(`/api/reminders/${id}`, { method: 'DELETE' });
      setReminders(prev => prev.filter(r => r.id !== id));
    } catch (error) {
      console.error('Failed to delete reminder:', error);
    }
  }

  if (loading) return <SkeletonReminders />;

  const overdue = reminders.filter(r => classifyReminder(r.remind_at) === 'overdue');
  const today = reminders.filter(r => classifyReminder(r.remind_at) === 'today');
  const upcoming = reminders.filter(r => classifyReminder(r.remind_at) === 'upcoming');

  const sections = [
    { label: 'Overdue', items: overdue, dotColor: 'bg-red-400', bgColor: 'bg-red-50 hover:bg-red-100/70', dotPulse: true },
    { label: 'Today', items: today, dotColor: 'bg-amber-400', bgColor: 'bg-amber-50 hover:bg-amber-100/70', dotPulse: false },
    { label: 'Upcoming', items: upcoming, dotColor: 'bg-blue-400', bgColor: 'hover:bg-muted/50', dotPulse: false },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="animate-fade-in">
        <h1 className="text-2xl sm:text-3xl font-bold">Reminders</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          {reminders.length} pending {reminders.length === 1 ? 'reminder' : 'reminders'}
        </p>
      </div>

      {reminders.length > 0 ? (
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
                    <Card key={reminder.id} className="border-0 shadow-sm">
                      <CardContent className={`py-3 px-4 rounded-xl ${section.bgColor} transition-colors`}>
                        <div className="flex items-start gap-3">
                          {/* Complete Button */}
                          <button
                            onClick={() => handleComplete(reminder.id)}
                            className={`mt-0.5 w-5 h-5 rounded-full border-2 flex-shrink-0 flex items-center justify-center transition-all ${
                              section.label === 'Overdue'
                                ? 'border-red-300 hover:bg-red-200 hover:border-red-400'
                                : section.label === 'Today'
                                ? 'border-amber-300 hover:bg-amber-200 hover:border-amber-400'
                                : 'border-blue-300 hover:bg-blue-200 hover:border-blue-400'
                            }`}
                            title="Mark as complete"
                          >
                            <Check className="w-3 h-3 opacity-0 hover:opacity-100 text-muted-foreground" />
                          </button>

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

                          {/* Delete */}
                          <button
                            onClick={() => handleDelete(reminder.id)}
                            className="p-1 rounded hover:bg-red-100 transition-colors flex-shrink-0"
                            title="Delete reminder"
                          >
                            <Trash2 className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
                          </button>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <Card className="animate-scale-in border-0 shadow-sm">
          <CardContent className="py-16 text-center">
            <div className="text-5xl mb-4">🔔</div>
            <h3 className="text-lg font-semibold">No pending reminders</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
              Set reminders from any contact&apos;s page to get nudged when it&apos;s time to reach out.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
