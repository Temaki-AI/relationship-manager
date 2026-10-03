'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Bell, BookOpen, Clock, Heart, ShieldCheck, Sparkles, Upload, UserPlus, Users } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button, buttonVariants } from '@/components/ui/button';
import type { DailyFeedItem } from '@/lib/intelligence';
import type { TodaySnooze } from '@/lib/today-snooze';
import { TodayFocus } from '@/components/today-focus';
import { FirstCircleJourney } from '@/components/first-circle-journey';
import type { FirstStepsSnapshot } from '@/lib/first-steps';

type DashboardStats = {
  totalContacts: number;
  overdueCount: number;
  checkInsDueCount: number;
  openReminderCount: number;
  strongRelationships: number;
};

type FeedItem = DailyFeedItem;

type SmartList = {
  id: string;
  title: string;
  description: string;
  tone: 'warm' | 'focus' | 'info';
  entries: Array<{
    id: number;
    name: string;
    reason: string;
  }>;
};

type OverviewResponse = {
  workspace?: {
    name: string;
    plan: string;
  };
  stats: DashboardStats;
  smartLists: SmartList[];
  feed: FeedItem[];
  snoozes: TodaySnooze[];
  firstSteps?: FirstStepsSnapshot;
};

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function SkeletonDashboard() {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <div className="skeleton h-8 w-64" />
        <div className="skeleton h-5 w-48" />
      </div>
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((index) => (
          <div key={index} className="skeleton h-28 rounded-xl" />
        ))}
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-[1.4fr_1fr] gap-6">
        <div className="skeleton h-80 rounded-xl" />
        <div className="skeleton h-80 rounded-xl" />
      </div>
    </div>
  );
}

function FirstRunDashboard({ workspaceName }: { workspaceName: string }) {
  return (
    <div className="space-y-6">
      <Card className="relative overflow-hidden border-0 shadow-sm animate-fade-in-up">
        <div className="absolute inset-0 z-0 bg-[radial-gradient(circle_at_top_left,hsl(var(--primary)/0.16),transparent_45%),linear-gradient(135deg,#fff7ed_0%,#fff_48%,#f0fdf4_100%)]" />
        <CardContent className="relative z-10 grid gap-8 px-6 py-10 sm:px-10 sm:py-14 lg:grid-cols-[1.3fr_0.7fr] lg:items-center">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/15 bg-white/80 px-3 py-1 text-xs font-semibold text-primary shadow-sm">
              <Heart className="h-3.5 w-3.5 fill-primary" />
              Welcome to {workspaceName}
            </div>
            <h1 className="mt-5 max-w-2xl text-3xl font-bold tracking-tight text-foreground sm:text-5xl">
              Start with a few people. Make the next moment count.
            </h1>
            <p className="mt-4 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
              A name is enough to begin. Choose a small circle, keep one detail worth remembering, and take a real next step. You can import only the people you want later.
            </p>
            <div className="mt-7 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/contacts/new"
                className={buttonVariants({ size: 'lg', className: 'w-full shadow-md shadow-primary/15 sm:w-auto' })}
              >
                <UserPlus className="h-4 w-4" />
                Add your first person
              </Link>
              <Link
                href="/contacts"
                className={buttonVariants({ size: 'lg', variant: 'outline', className: 'w-full bg-white/70 sm:w-auto' })}
              >
                <Upload className="h-4 w-4" />
                Preview a contact import
              </Link>
            </div>
          </div>

          <div className="rounded-2xl border border-white/80 bg-white/75 p-5 shadow-lg shadow-rose-100/50 backdrop-blur-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Private by default</p>
            <div className="mt-4 space-y-4">
              <div className="flex gap-3">
                <ShieldCheck className="mt-0.5 h-5 w-5 flex-shrink-0 text-emerald-600" />
                <div>
                  <p className="text-sm font-semibold">Your data stays yours</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Contact files are processed by your Everclose deployment, not a third-party enrichment service. Cloud imports include a preview and a saved report.</p>
                </div>
              </div>
              <div className="flex gap-3">
                <BookOpen className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600" />
                <div>
                  <p className="text-sm font-semibold">Start with what you know</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">A name is enough. Add context naturally after each conversation.</p>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-3 stagger-children">
        {[
          { step: '01', title: 'Choose a few people', detail: 'Start with one to five names. Your full address book can wait.' },
          { step: '02', title: 'Keep one detail', detail: 'A birthday or check-in preference helps you remember what matters.' },
          { step: '03', title: 'Take one real step', detail: 'Log a conversation you had or plan a reminder. Opening a message app never counts as contact.' },
        ].map((item) => (
          <Card key={item.step} className="border-0 shadow-sm">
            <CardContent className="p-5">
              <span className="font-mono text-xs font-semibold text-primary">{item.step}</span>
              <h2 className="mt-3 font-semibold">{item.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{item.detail}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const hasOverview = useRef(false);
  const lastLoadedAt = useRef(0);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const scheduleNextDay = () => {
      const nextDay = new Date();
      nextDay.setHours(24, 0, 1, 0);
      timer = setTimeout(() => {
        setRefreshToken((value) => value + 1);
        scheduleNextDay();
      }, Math.max(1_000, nextDay.getTime() - Date.now()));
    };
    const refreshOnReturn = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastLoadedAt.current > 5 * 60_000) {
        setRefreshToken((value) => value + 1);
      }
    };
    scheduleNextDay();
    document.addEventListener('visibilitychange', refreshOnReturn);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', refreshOnReturn);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function fetchOverview() {
      if (!hasOverview.current) setLoading(true);
      setLoadError(null);

      try {
        const query = new URLSearchParams({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
        const res = await fetch(`/api/intelligence/overview?${query}`, { cache: 'no-store' });
        if (!res.ok) {
          throw new Error('Failed to load workspace intelligence');
        }

        const data = await res.json() as OverviewResponse;
        if (!cancelled) {
          setOverview(data);
          hasOverview.current = true;
          lastLoadedAt.current = Date.now();
        }
      } catch (error) {
        console.error('Failed to fetch intelligence overview:', error);
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : 'Failed to load the dashboard');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchOverview();

    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  if (loading) {
    return <SkeletonDashboard />;
  }

  if (!overview) {
    return (
      <Card className="border-0 shadow-sm">
        <CardContent className="py-16 text-center">
          <div className="text-4xl mb-4">⚠️</div>
          <h1 className="text-xl font-semibold text-foreground">Workspace intelligence unavailable</h1>
          <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
            {loadError || 'The dashboard could not be generated right now.'}
          </p>
          <Button className="mt-6" onClick={() => setRefreshToken((value) => value + 1)}>
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (overview.stats.totalContacts === 0) {
    return <FirstRunDashboard workspaceName={overview.workspace?.name || 'Everclose CRM'} />;
  }

  const greeting = getGreeting();
  const spotlightLists = overview.smartLists.filter((list) => list.entries.length > 0).slice(0, 3);
  const priorityFeed = overview.feed;

  return (
    <div className="space-y-8">
      <div className="animate-fade-in-up flex flex-col gap-4 border-b border-border/70 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">Today</h1>
          <p className="mt-2 text-sm text-muted-foreground sm:text-base">{greeting}. A little context for the people who matter.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/contacts" className={buttonVariants({ variant: 'outline', size: 'sm' })}><Users className="h-4 w-4" />People</Link>
          <Link href="/contacts/new" className={buttonVariants({ size: 'sm' })}><UserPlus className="h-4 w-4" />Add person</Link>
        </div>
      </div>

      {loadError && (
        <Card className="border-0 shadow-sm bg-amber-50/80">
          <CardContent className="py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">Some relationship insights could not be refreshed.</p>
              <p className="text-sm text-muted-foreground">{loadError}</p>
            </div>
            <Button variant="secondary" onClick={() => setRefreshToken((value) => value + 1)}>
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {overview.firstSteps && !overview.firstSteps.hasLoggedMoment && (
        <FirstCircleJourney snapshot={overview.firstSteps} onChanged={() => setRefreshToken((value) => value + 1)} />
      )}

      <TodayFocus items={priorityFeed} snoozes={overview.snoozes || []} onChanged={() => setRefreshToken((value) => value + 1)} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 stagger-children">
        <Card className="relative overflow-hidden border-0 shadow-sm">
          <div className="absolute inset-0 bg-gradient-to-br from-rose-50 to-pink-50" />
          <CardContent className="relative pt-5 pb-4 px-4 sm:px-5">
            <Users className="w-4 h-4 text-rose-600 mb-3" />
            <div className="text-2xl sm:text-3xl font-bold text-foreground">{overview.stats.totalContacts}</div>
            <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">people in your network</p>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden border-0 shadow-sm">
          <div className="absolute inset-0 bg-gradient-to-br from-amber-50 to-orange-50" />
          <CardContent className="relative pt-5 pb-4 px-4 sm:px-5">
            <Clock className="w-4 h-4 text-amber-600 mb-3" />
            <div className="text-2xl sm:text-3xl font-bold text-foreground">{overview.stats.checkInsDueCount}</div>
            <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">check-ins due</p>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden border-0 shadow-sm">
          <div className="absolute inset-0 bg-gradient-to-br from-blue-50 to-indigo-50" />
          <CardContent className="relative pt-5 pb-4 px-4 sm:px-5">
            <Bell className="w-4 h-4 text-blue-600 mb-3" />
            <div className="text-2xl sm:text-3xl font-bold text-foreground">{overview.stats.openReminderCount}</div>
            <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">open reminders</p>
          </CardContent>
        </Card>

      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6 stagger-children">
        {spotlightLists.length > 0 ? (
          spotlightLists.map((list) => (
            <Card key={list.id} className="border-0 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold">{list.title}</CardTitle>
                <p className="text-sm text-muted-foreground">{list.description}</p>
              </CardHeader>
              <CardContent className="space-y-3">
                {list.entries.slice(0, 4).map((entry) => (
                  <Link
                    key={entry.id}
                    href={`/contacts/${entry.id}`}
                    className="flex items-start justify-between gap-3 rounded-xl p-3 hover:bg-muted/40 transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-sm text-foreground">{entry.name}</p>
                      <p className="text-xs text-muted-foreground mt-1">{entry.reason}</p>
                    </div>
                    <ArrowRight className="w-4 h-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                  </Link>
                ))}
                <Link href="/smart-lists" className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
                  View full smart list
                  <ArrowRight className="w-4 h-4" />
                </Link>
              </CardContent>
            </Card>
          ))
        ) : (
          <Card className="border-0 shadow-sm lg:col-span-3">
            <CardContent className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <span className="rounded-xl bg-rose-50 p-2.5 text-primary"><Sparkles className="h-5 w-5" /></span>
                <div>
                  <h3 className="font-semibold">Your relationship patterns are taking shape</h3>
                  <p className="mt-1 max-w-xl text-sm text-muted-foreground">As you add people and log moments, smart lists will surface connections worth revisiting.</p>
                </div>
              </div>
              <Link href="/smart-lists" className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-primary hover:underline">Explore smart lists <ArrowRight className="h-4 w-4" /></Link>
            </CardContent>
          </Card>
        )}
      </div>

    </div>
  );
}
