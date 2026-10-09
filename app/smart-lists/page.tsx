'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Search, Sparkles } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { LoadError } from '@/components/ui/load-error';
import { getResponseErrorMessage } from '@/lib/utils';

type SmartList = {
  id: string;
  title: string;
  description: string;
  tone: 'warm' | 'focus' | 'info';
  entries: Array<{
    id: number;
    name: string;
    reason: string;
    subtitle?: string;
  }>;
};

export default function SmartListsPage() {
  const [smartLists, setSmartLists] = useState<SmartList[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [search, setSearch] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    async function fetchSmartLists() {
      setLoading(true);
      try {
        const query = new URLSearchParams({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
        const res = await fetch(`/api/smart-lists?${query}`, { cache: 'no-store', signal: controller.signal });
        if (!res.ok) {
          throw new Error(await getResponseErrorMessage(res, 'Failed to load smart lists'));
        }
        const data = await res.json();
        setSmartLists(Array.isArray(data.smartLists) ? data.smartLists : []);
        setLoadError(null);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.error('Failed to fetch smart lists:', error);
        setLoadError(error instanceof Error ? error.message : 'Failed to load smart lists');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    fetchSmartLists();
    return () => controller.abort();
  }, [reloadToken]);

  const filteredLists = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return smartLists;

    return smartLists.filter((list) =>
      list.title.toLowerCase().includes(term) ||
      list.description.toLowerCase().includes(term) ||
      list.entries.some((entry) =>
        entry.name.toLowerCase().includes(term) ||
        entry.reason.toLowerCase().includes(term) ||
        entry.subtitle?.toLowerCase().includes(term)
      )
    );
  }, [search, smartLists]);

  if (loading && !loadError) {
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <div className="skeleton h-9 w-48" />
          <div className="skeleton h-5 w-72" />
        </div>
        <div className="skeleton h-11 rounded-xl" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {[1, 2, 3, 4].map((index) => (
            <div key={index} className="skeleton h-72 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="space-y-6">
        <div className="animate-fade-in">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            <h1 className="text-2xl font-bold sm:text-3xl">Smart Lists</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Saved relationship views generated from your interaction history, reminders, and enrichment context.
          </p>
        </div>
        <LoadError
          title="We couldn't load your smart lists"
          message={`${loadError}. No relationship view is being shown as empty.`}
          retrying={loading}
          onRetry={() => setReloadToken((value) => value + 1)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="animate-fade-in">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-primary" />
          <h1 className="text-2xl sm:text-3xl font-bold">Smart Lists</h1>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Saved relationship views generated from your interaction history, reminders, and enrichment context.
        </p>
      </div>

      <div className="relative animate-fade-in-up">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground w-4 h-4" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search smart lists, people, reasons, or context..."
          className="pl-10 h-11 bg-card border-border/60 rounded-xl"
        />
      </div>

      {filteredLists.length > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 stagger-children">
          {filteredLists.map((list) => (
            <Card key={list.id} className="border-border/70 shadow-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold">{list.title}</CardTitle>
                <p className="text-sm text-muted-foreground">{list.description}</p>
              </CardHeader>
              <CardContent className="space-y-3">
                {list.entries.length > 0 ? (
                  list.entries.map((entry) => (
                    <Link
                      key={entry.id}
                      href={`/contacts/${entry.id}`}
                      className="flex items-start justify-between gap-3 rounded-xl border border-border/50 bg-card/70 p-3 hover:bg-muted/40 transition-colors"
                    >
                      <div className="min-w-0">
                        <p className="font-medium text-sm">{entry.name}</p>
                        <p className="text-xs text-muted-foreground mt-1">{entry.reason}</p>
                        {entry.subtitle && (
                          <p className="text-[11px] text-muted-foreground mt-1">{entry.subtitle}</p>
                        )}
                      </div>
                      <ArrowRight className="w-4 h-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                    </Link>
                  ))
                ) : (
                  <div className="rounded-xl border border-dashed border-border p-6 text-center">
                    <p className="text-sm text-muted-foreground">This smart list is ready, but it does not have matching contacts yet.</p>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card className="border-border/70 shadow-card">
          <CardContent className="py-16 text-center">
            <div className="text-4xl mb-3">🔎</div>
            <h3 className="text-lg font-semibold">No smart lists matched</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Try a different keyword or clear the search to see all generated views.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
