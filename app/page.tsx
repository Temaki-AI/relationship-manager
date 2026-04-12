'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Bell, CalendarDays, Clock, Heart, PlugZap, Sparkles, Users } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type DashboardStats = {
  totalContacts: number;
  overdueCount: number;
  openReminderCount: number;
  connectedIntegrations: number;
  strongRelationships: number;
};

type FeedItem = {
  id: string;
  type: 'reminder' | 'birthday' | 'relationship' | 'integration' | 'signal';
  title: string;
  detail: string;
  href: string;
  priority: 'high' | 'medium' | 'low';
};

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

type IntegrationSnapshot = {
  id: number;
  provider: string;
  label: string;
  status: 'connected' | 'attention' | 'disconnected';
  account_email: string | null;
  last_synced_at: string | null;
  latest_job: {
    status: string;
    summary: string | null;
    started_at: string;
  } | null;
};

type OverviewResponse = {
  workspace?: {
    name: string;
    plan: string;
  };
  stats: DashboardStats;
  smartLists: SmartList[];
  feed: FeedItem[];
  integrations: IntegrationSnapshot[];
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
      <div className="grid grid-cols-2 xl:grid-cols-5 gap-4">
        {[1, 2, 3, 4, 5].map((index) => (
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

function getPriorityClasses(priority: FeedItem['priority']) {
  if (priority === 'high') return 'bg-rose-50 text-rose-700 border-rose-200/60';
  if (priority === 'medium') return 'bg-amber-50 text-amber-700 border-amber-200/60';
  return 'bg-slate-50 text-slate-700 border-slate-200/60';
}

function getIntegrationClasses(status: IntegrationSnapshot['status']) {
  if (status === 'connected') return 'bg-emerald-50 text-emerald-700 border-emerald-200/60';
  if (status === 'attention') return 'bg-amber-50 text-amber-700 border-amber-200/60';
  return 'bg-slate-50 text-slate-700 border-slate-200/60';
}

export default function Dashboard() {
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function fetchOverview() {
      setLoading(true);
      setLoadError(null);

      try {
        const res = await fetch('/api/intelligence/overview', { cache: 'no-store' });
        if (!res.ok) {
          throw new Error('Failed to load workspace intelligence');
        }

        const data = await res.json() as OverviewResponse;
        if (!cancelled) {
          setOverview(data);
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

  const greeting = getGreeting();
  const spotlightLists = overview.smartLists.filter((list) => list.entries.length > 0).slice(0, 3);
  const priorityFeed = overview.feed.slice(0, 6);
  const integrations = overview.integrations.slice(0, 4);

  return (
    <div className="space-y-8">
      <div className="animate-fade-in-up flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground">
            {greeting.text} {greeting.emoji}
          </h1>
          <p className="text-muted-foreground mt-1">
            {overview.workspace?.name || 'Bonds'} is acting like your relationship operating system today.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/smart-lists">
            <Button variant="outline" size="sm">
              <Sparkles className="w-4 h-4 mr-1.5" />
              Open smart lists
            </Button>
          </Link>
          <Link href="/integrations">
            <Button size="sm">
              <PlugZap className="w-4 h-4 mr-1.5" />
              Manage integrations
            </Button>
          </Link>
        </div>
      </div>

      {loadError && (
        <Card className="border-0 shadow-sm bg-amber-50/80">
          <CardContent className="py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">Some automation surfaces could not be refreshed.</p>
              <p className="text-sm text-muted-foreground">{loadError}</p>
            </div>
            <Button variant="secondary" onClick={() => setRefreshToken((value) => value + 1)}>
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 xl:grid-cols-5 gap-3 sm:gap-4 stagger-children">
        <Card className="relative overflow-hidden border-0 shadow-sm">
          <div className="absolute inset-0 bg-gradient-to-br from-rose-50 to-pink-50" />
          <CardContent className="relative pt-5 pb-4 px-4 sm:px-5">
            <Users className="w-4 h-4 text-rose-600 mb-3" />
            <div className="text-2xl sm:text-3xl font-bold text-foreground">{overview.stats.totalContacts}</div>
            <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">people in your network</p>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden border-0 shadow-sm">
          <div className="absolute inset-0 bg-gradient-to-br from-emerald-50 to-green-50" />
          <CardContent className="relative pt-5 pb-4 px-4 sm:px-5">
            <Heart className="w-4 h-4 text-emerald-600 mb-3 fill-emerald-600" />
            <div className="text-2xl sm:text-3xl font-bold text-foreground">{overview.stats.strongRelationships}</div>
            <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">strong relationships</p>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden border-0 shadow-sm">
          <div className="absolute inset-0 bg-gradient-to-br from-amber-50 to-orange-50" />
          <CardContent className="relative pt-5 pb-4 px-4 sm:px-5">
            <Clock className="w-4 h-4 text-amber-600 mb-3" />
            <div className="text-2xl sm:text-3xl font-bold text-foreground">{overview.stats.overdueCount}</div>
            <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">need attention</p>
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

        <Card className="relative overflow-hidden border-0 shadow-sm col-span-2 xl:col-span-1">
          <div className="absolute inset-0 bg-gradient-to-br from-violet-50 to-fuchsia-50" />
          <CardContent className="relative pt-5 pb-4 px-4 sm:px-5">
            <PlugZap className="w-4 h-4 text-violet-600 mb-3" />
            <div className="text-2xl sm:text-3xl font-bold text-foreground">{overview.stats.connectedIntegrations}</div>
            <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">connected systems</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1.4fr_1fr] gap-6">
        <Card className="border-0 shadow-sm animate-fade-in-up">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle className="text-base font-semibold">Today&apos;s focus queue</CardTitle>
                <p className="text-sm text-muted-foreground mt-1">What Bonds thinks deserves your attention next.</p>
              </div>
              <Link href="/reminders" className="text-sm text-primary hover:underline">
                Open reminders
              </Link>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {priorityFeed.length > 0 ? (
              priorityFeed.map((item) => (
                <Link
                  key={item.id}
                  href={item.href}
                  className="flex items-start gap-3 rounded-xl border border-border/60 bg-white/80 p-3 hover:bg-muted/40 transition-colors"
                >
                  <div className={`mt-0.5 rounded-full px-2 py-0.5 text-[10px] font-semibold border ${getPriorityClasses(item.priority)}`}>
                    {item.priority.toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm text-foreground">{item.title}</p>
                    <p className="text-xs text-muted-foreground mt-1">{item.detail}</p>
                  </div>
                  <ArrowRight className="w-4 h-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                </Link>
              ))
            ) : (
              <div className="text-center py-10">
                <div className="text-3xl mb-2">✨</div>
                <p className="text-sm text-muted-foreground">No urgent queue items right now.</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-0 shadow-sm animate-fade-in-up">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle className="text-base font-semibold">Integration health</CardTitle>
                <p className="text-sm text-muted-foreground mt-1">Automation surfaces and sync readiness.</p>
              </div>
              <Link href="/integrations" className="text-sm text-primary hover:underline">
                See all
              </Link>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {integrations.map((integration) => (
              <div key={integration.id} className="rounded-xl border border-border/60 bg-white/80 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-sm">{integration.label}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {integration.account_email || integration.latest_job?.summary || 'Not connected yet'}
                    </p>
                  </div>
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${getIntegrationClasses(integration.status)}`}>
                    {integration.status}
                  </span>
                </div>
              </div>
            ))}
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
            <CardContent className="py-16 text-center">
              <div className="text-5xl mb-4">🧠</div>
              <h3 className="text-lg font-semibold">Smart lists wake up as your data gets richer</h3>
              <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
                Add contacts, import LinkedIn profiles, and connect more systems to unlock saved views and automated follow-up workflows.
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      <Card className="border-0 shadow-sm animate-fade-in-up">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <CalendarDays className="w-4 h-4 text-primary" />
            <CardTitle className="text-base font-semibold">V2 rollout momentum</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="rounded-xl border border-border/60 bg-white/80 p-4">
            <p className="text-sm font-medium">Foundation</p>
            <p className="text-xs text-muted-foreground mt-1">Workspace, integrations, sync jobs, smart lists, and relationship briefs are now live in the app shell.</p>
          </div>
          <div className="rounded-xl border border-border/60 bg-white/80 p-4">
            <p className="text-sm font-medium">Workflow surfaces</p>
            <p className="text-xs text-muted-foreground mt-1">The dashboard now behaves like a daily action center instead of a passive summary page.</p>
          </div>
          <div className="rounded-xl border border-border/60 bg-white/80 p-4">
            <p className="text-sm font-medium">Next leverage</p>
            <p className="text-xs text-muted-foreground mt-1">Google/Microsoft account sync, richer organization identities, and real AI actions are the next major unlocks.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
