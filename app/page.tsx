'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Sparkles, Upload, UserPlus } from 'lucide-react';
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
  return <section className="mx-auto max-w-xl space-y-5 py-8 sm:py-12">
    <p className="text-sm text-muted-foreground">Welcome to {workspaceName}</p>
    <h1 className="text-3xl font-bold tracking-tight">Start with one person</h1>
    <p className="text-base leading-relaxed text-muted-foreground">A name is enough. Add someone you want to stay close to, then save a detail or plan your next conversation.</p>
    <div className="flex flex-wrap gap-3">
      <Link href="/contacts/new" className={buttonVariants()}><UserPlus className="h-4 w-4" />Add your first person</Link>
      <Link href="/contacts?import=1" className={buttonVariants({ variant: 'outline' })}><Upload className="h-4 w-4" />Import contacts</Link>
    </div>
    <p className="text-sm text-muted-foreground">Imports start with a preview. You choose what to save.</p>
  </section>;
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
      <Card className="border-border/70 shadow-card">
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
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Today</h1>
        <p className="text-sm text-muted-foreground">{greeting}.</p>
      </div>

      {loadError && (
        <Card className="border-border/70 shadow-card bg-warning-soft/80">
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

      <TodayFocus items={priorityFeed} snoozes={overview.snoozes || []} onChanged={() => setRefreshToken((value) => value + 1)} />

      {overview.firstSteps && !overview.firstSteps.hasLoggedMoment && <details className="rounded-xl border border-border bg-card px-4">
        <summary className="flex min-h-12 cursor-pointer items-center py-3 text-sm font-medium">Set up your first connections</summary>
        <div className="pb-4"><FirstCircleJourney snapshot={overview.firstSteps} onChanged={() => setRefreshToken((value) => value + 1)} /></div>
      </details>}

      <details className="rounded-xl border border-border bg-card px-4">
        <summary className="flex min-h-12 cursor-pointer items-center justify-between gap-3 py-3 text-sm font-medium">
          <span>Relationship overview</span><span className="text-muted-foreground">{overview.stats.totalContacts} people</span>
        </summary>
        <dl className="mb-5 grid grid-cols-3 gap-3 border-t border-border pt-4 text-sm">
          <div><dt className="text-muted-foreground">People</dt><dd className="mt-1 text-lg font-semibold">{overview.stats.totalContacts}</dd></div>
          <div><dt className="text-muted-foreground">Check-ins due</dt><dd className="mt-1 text-lg font-semibold">{overview.stats.checkInsDueCount}</dd></div>
          <div><dt className="text-muted-foreground">Open reminders</dt><dd className="mt-1 text-lg font-semibold">{overview.stats.openReminderCount}</dd></div>
        </dl>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6 stagger-children">
        {spotlightLists.length > 0 ? (
          spotlightLists.map((list) => (
            <Card key={list.id} className="border-border/70 shadow-card">
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
          <Card className="border-border/70 shadow-card lg:col-span-3">
            <CardContent className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <span className="rounded-xl bg-secondary p-2.5 text-primary"><Sparkles className="h-5 w-5" /></span>
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
      </details>
    </div>
  );
}
