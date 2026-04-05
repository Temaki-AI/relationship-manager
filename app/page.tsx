'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Users, MessageSquare, AlertCircle, Cake, ArrowRight, Bell, Clock, Heart, Sparkles, Check } from 'lucide-react';
import type { Contact } from '@/lib/db';
import { calculateRelationshipHealth, formatRelativeDate, getResponseErrorMessage, parseTags } from '@/lib/utils';
import { Avatar } from '@/components/ui/avatar';
import { useToast } from '@/components/ui/toast';

type Stats = {
  totalContacts: number;
  conversationsThisWeek: number;
  neglectedCount: number;
  upcomingBirthdaysCount: number;
};

type Birthday = {
  id: number;
  name: string;
  birthday: string;
  daysUntil: number;
};

type Reminder = {
  id: number;
  contact_id: number;
  contact_name: string;
  title: string;
  notes: string | null;
  remind_at: string;
};

function getGreeting(): { text: string; emoji: string } {
  const hour = new Date().getHours();
  if (hour < 6) return { text: 'Burning the midnight oil', emoji: '🌙' };
  if (hour < 12) return { text: 'Good morning', emoji: '☀️' };
  if (hour < 17) return { text: 'Good afternoon', emoji: '👋' };
  if (hour < 21) return { text: 'Good evening', emoji: '🌅' };
  return { text: 'Good evening', emoji: '🌙' };
}

function SkeletonDashboard() {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <div className="skeleton h-8 w-64" />
        <div className="skeleton h-5 w-48" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="skeleton h-28 rounded-xl" />
        ))}
      </div>
      <div className="skeleton h-48 rounded-xl" />
    </div>
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [actionItems, setActionItems] = useState<Contact[]>([]);
  const [birthdays, setBirthdays] = useState<Birthday[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  useEffect(() => {
    async function fetchData() {
      try {
        const [statsRes, contactsRes, remindersRes] = await Promise.all([
          fetch('/api/stats'),
          fetch('/api/contacts'),
          fetch('/api/reminders')
        ]);

        const statsData = await statsRes.json();
        const contactsData = await contactsRes.json();
        const remindersData = await remindersRes.json();

        setStats(statsData.stats);
        setBirthdays(statsData.upcomingBirthdays || []);
        setReminders(remindersData.reminders || []);

        const actionContacts = contactsData.contacts.filter((c: Contact) =>
          statsData.actionItems.includes(c.id)
        );
        setActionItems(actionContacts);
      } catch (error) {
        console.error('Failed to fetch dashboard data:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, []);

  if (loading) {
    return <SkeletonDashboard />;
  }

  const greeting = getGreeting();

  return (
    <div className="space-y-8">
      {/* Greeting */}
      <div className="animate-fade-in-up">
        <h1 className="text-2xl sm:text-3xl font-bold text-foreground">
          {greeting.text} {greeting.emoji}
        </h1>
        <p className="text-muted-foreground mt-1">
          Here&apos;s how your relationships are doing
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 stagger-children">
        <Card className="relative overflow-hidden border-0 shadow-sm hover:shadow-md transition-shadow">
          <div className="absolute inset-0 bg-gradient-to-br from-rose-50 to-pink-50" />
          <CardContent className="relative pt-5 pb-4 px-4 sm:px-5">
            <div className="flex items-center justify-between mb-3">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-rose-400 to-pink-500 flex items-center justify-center shadow-sm">
                <Users className="w-4 h-4 text-white" />
              </div>
            </div>
            <div className="text-2xl sm:text-3xl font-bold text-foreground">{stats?.totalContacts || 0}</div>
            <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">contacts</p>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden border-0 shadow-sm hover:shadow-md transition-shadow">
          <div className="absolute inset-0 bg-gradient-to-br from-blue-50 to-indigo-50" />
          <CardContent className="relative pt-5 pb-4 px-4 sm:px-5">
            <div className="flex items-center justify-between mb-3">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-400 to-indigo-500 flex items-center justify-center shadow-sm">
                <MessageSquare className="w-4 h-4 text-white" />
              </div>
            </div>
            <div className="text-2xl sm:text-3xl font-bold text-foreground">{stats?.conversationsThisWeek || 0}</div>
            <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">this week</p>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden border-0 shadow-sm hover:shadow-md transition-shadow">
          <div className="absolute inset-0 bg-gradient-to-br from-amber-50 to-orange-50" />
          <CardContent className="relative pt-5 pb-4 px-4 sm:px-5">
            <div className="flex items-center justify-between mb-3">
              <div className={`w-9 h-9 rounded-xl flex items-center justify-center shadow-sm ${
                (stats?.neglectedCount || 0) > 0
                  ? 'bg-gradient-to-br from-amber-400 to-orange-500'
                  : 'bg-gradient-to-br from-emerald-400 to-green-500'
              }`}>
                {(stats?.neglectedCount || 0) > 0
                  ? <AlertCircle className="w-4 h-4 text-white" />
                  : <Heart className="w-4 h-4 text-white fill-white" />
                }
              </div>
            </div>
            <div className="text-2xl sm:text-3xl font-bold text-foreground">{stats?.neglectedCount || 0}</div>
            <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
              {(stats?.neglectedCount || 0) === 0 ? 'all caught up!' : 'need love'}
            </p>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden border-0 shadow-sm hover:shadow-md transition-shadow">
          <div className="absolute inset-0 bg-gradient-to-br from-purple-50 to-violet-50" />
          <CardContent className="relative pt-5 pb-4 px-4 sm:px-5">
            <div className="flex items-center justify-between mb-3">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-purple-400 to-violet-500 flex items-center justify-center shadow-sm">
                <Cake className="w-4 h-4 text-white" />
              </div>
            </div>
            <div className="text-2xl sm:text-3xl font-bold text-foreground">{stats?.upcomingBirthdaysCount || 0}</div>
            <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">birthdays soon</p>
          </CardContent>
        </Card>
      </div>

      {/* Action Items */}
      {actionItems.length > 0 && (
        <Card className="animate-fade-in-up border-0 shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-amber-100 flex items-center justify-center">
                <Clock className="w-3.5 h-3.5 text-amber-600" />
              </div>
              <CardTitle className="text-base font-semibold">Reach out to</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {actionItems.map((contact) => {
                const health = calculateRelationshipHealth(contact);
                return (
                  <Link
                    key={contact.id}
                    href={`/contacts/${contact.id}`}
                    className="flex items-center gap-3 p-3 rounded-xl hover:bg-muted/50 transition-colors group"
                  >
                    <Avatar contact={contact} size="sm" className="w-10 h-10" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-sm truncate">{contact.name}</p>
                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                          health >= 50 ? 'bg-amber-400' : 'bg-red-400'
                        }`} />
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
                        {formatRelativeDate(contact.last_contacted)}
                        {parseTags(contact.tags).length > 0 && ` · ${parseTags(contact.tags)[0]}`}
                      </p>
                    </div>
                    <ArrowRight className="w-4 h-4 text-muted-foreground group-hover:text-foreground group-hover:translate-x-0.5 transition-all flex-shrink-0" />
                  </Link>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Birthdays & Reminders side by side on desktop */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        {/* Upcoming Birthdays */}
        {birthdays.length > 0 && (
          <Card className="animate-fade-in-up border-0 shadow-sm">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-purple-100 flex items-center justify-center">
                  <Cake className="w-3.5 h-3.5 text-purple-600" />
                </div>
                <CardTitle className="text-base font-semibold">Upcoming birthdays</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {birthdays.map((birthday) => (
                  <Link
                    key={birthday.id}
                    href={`/contacts/${birthday.id}`}
                    className="flex items-center gap-3 p-3 rounded-xl hover:bg-muted/50 transition-colors"
                  >
                    <Avatar contact={{ name: birthday.name }} size="sm" className="w-10 h-10" />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm">{birthday.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {birthday.daysUntil === 0
                          ? '🎉 Today!'
                          : birthday.daysUntil === 1
                          ? 'Tomorrow'
                          : `In ${birthday.daysUntil} days`}
                      </p>
                    </div>
                    <Badge variant="secondary" className="text-xs font-normal">
                      {birthday.birthday.substring(5)}
                    </Badge>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Upcoming Reminders */}
        {reminders.length > 0 && (
          <Card className="animate-fade-in-up border-0 shadow-sm">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-blue-100 flex items-center justify-center">
                  <Bell className="w-3.5 h-3.5 text-blue-600" />
                </div>
                <CardTitle className="text-base font-semibold">Reminders</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {reminders.slice(0, 5).map((reminder) => {
                  const remindDate = new Date(reminder.remind_at);
                  const now = new Date();
                  const isPast = remindDate < now;
                  const isToday = remindDate.toDateString() === now.toDateString();

                  return (
                    <Link
                      key={reminder.id}
                      href={`/contacts/${reminder.contact_id}`}
                      className={`flex items-start gap-3 p-3 rounded-xl transition-colors ${
                        isPast
                          ? 'bg-red-50 hover:bg-red-100/70'
                          : isToday
                          ? 'bg-amber-50 hover:bg-amber-100/70'
                          : 'hover:bg-muted/50'
                      }`}
                    >
                      <button
                        onClick={async (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          try {
                            const res = await fetch(`/api/reminders/${reminder.id}`, {
                              method: 'PATCH',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ completed: true }),
                            });
                            if (!res.ok) {
                              toast({ message: await getResponseErrorMessage(res, 'Failed to complete reminder'), variant: 'error' });
                              return;
                            }
                            setReminders(prev => prev.filter(r => r.id !== reminder.id));
                            toast({ message: 'Reminder completed' });
                          } catch (error) {
                            console.error('Failed to complete reminder:', error);
                            toast({ message: 'Failed to complete reminder', variant: 'error' });
                          }
                        }}
                        className={`mt-0.5 w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center transition-all hover:scale-110 ${
                          isPast
                            ? 'border-red-300 hover:bg-red-200 hover:border-red-400'
                            : isToday
                            ? 'border-amber-300 hover:bg-amber-200 hover:border-amber-400'
                            : 'border-blue-300 hover:bg-blue-200 hover:border-blue-400'
                        }`}
                        title="Mark as complete"
                      >
                        <Check className="w-2.5 h-2.5 opacity-0 hover:opacity-100 text-muted-foreground" />
                      </button>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm">{reminder.contact_name}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{reminder.title}</p>
                        <p className="text-[10px] text-muted-foreground mt-1">
                          {isPast ? 'Overdue' : isToday ? 'Today' : remindDate.toLocaleDateString()}
                        </p>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Empty state when everything is great */}
      {actionItems.length === 0 && birthdays.length === 0 && reminders.length === 0 && (stats?.totalContacts || 0) > 0 && (
        <Card className="animate-scale-in border-0 shadow-sm">
          <CardContent className="py-12 text-center">
            <div className="text-4xl mb-3">✨</div>
            <h3 className="text-lg font-semibold text-foreground">All caught up!</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
              You&apos;re on top of all your relationships. Nice work keeping in touch with the people who matter.
            </p>
          </CardContent>
        </Card>
      )}

      {/* First-time empty state */}
      {(stats?.totalContacts || 0) === 0 && (
        <Card className="animate-scale-in border-0 shadow-sm">
          <CardContent className="py-16 text-center">
            <div className="text-5xl mb-4">💝</div>
            <h3 className="text-xl font-semibold text-foreground">Welcome to Bonds</h3>
            <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
              Start by adding the people who matter most to you. We&apos;ll help you stay connected.
            </p>
            <Link href="/contacts/new">
              <Button className="mt-6 shadow-sm">
                <Sparkles className="w-4 h-4 mr-2" />
                Add your first contact
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
