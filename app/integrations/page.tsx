'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  CloudOff,
  ContactRound,
  DatabaseBackup,
  FileSpreadsheet,
  HardDrive,
  Linkedin,
  PlugZap,
  ShieldCheck,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button, buttonVariants } from '@/components/ui/button';
import type { DataCapability } from '@/lib/data-capabilities';
import { getResponseErrorMessage } from '@/lib/utils';

type IntegrationResponse = {
  workspace?: {
    name: string;
    mode: 'local' | 'cloud';
  };
  capabilities: DataCapability[];
  automaticAccountSync: {
    enabled: false;
    message: string;
  };
};

const CAPABILITY_ICONS: Record<DataCapability['id'], React.ElementType> = {
  vcard: ContactRound,
  csv: FileSpreadsheet,
  'encrypted-backup': DatabaseBackup,
  'linkedin-extension': Linkedin,
  'linkedin-link': Linkedin,
};

function SkeletonConnections() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="skeleton h-9 w-56" />
        <div className="skeleton h-5 w-full max-w-xl" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {[1, 2, 3, 4].map((index) => (
          <div key={index} className="skeleton h-56 rounded-xl" />
        ))}
      </div>
    </div>
  );
}

export default function IntegrationsPage() {
  const [data, setData] = useState<IntegrationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function fetchCapabilities() {
      setLoading(true);
      setLoadError(null);

      try {
        const response = await fetch('/api/integrations', { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(await getResponseErrorMessage(response, 'Failed to load data connections'));
        }
        const next = await response.json() as IntegrationResponse;
        if (!cancelled) setData(next);
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : 'Failed to load data connections');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchCapabilities();
    return () => { cancelled = true; };
  }, [refreshToken]);

  if (loading) return <SkeletonConnections />;

  if (!data) {
    return (
      <Card className="mx-auto max-w-xl border-border/70 shadow-card">
        <CardContent className="py-14 text-center">
          <CloudOff className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden="true" />
          <h1 className="mt-4 text-xl font-semibold">Data connections are unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">{loadError}</p>
          <Button className="mt-6" onClick={() => setRefreshToken((value) => value + 1)}>
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-8">
      <div className="animate-fade-in">
        <div className="flex items-center gap-2">
          <PlugZap className="h-5 w-5 text-primary" aria-hidden="true" />
          <h1 className="text-2xl font-bold sm:text-3xl">Connections</h1>
        </div>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Choose what to bring into Everclose. Review imports before saving them.
        </p>
      </div>

      <section aria-labelledby="available-connections-heading">
        {data.workspace?.mode === 'cloud' && <Card className="mb-6 border-border/70 shadow-card">
          <CardHeader><CardTitle className="text-base">Google account authorization</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap gap-3">
            <p className="text-sm text-muted-foreground">Review Google Contacts imports and updates, or authorize Calendar separately and choose calendars for event context.</p>
            <Link href="/connections/google" className={buttonVariants({ variant: 'outline', size: 'sm' })}>Manage Google Contacts</Link>
            <Link href="/connections/google/calendar" className={buttonVariants({ variant: 'outline', size: 'sm' })}>Manage Google Calendar</Link>
            <Link href="/connections/google/publish" className={buttonVariants({ variant: 'outline', size: 'sm' })}>Calendar publishing setup</Link>
            <Link href="/connections/google/gmail" className={buttonVariants({ variant: 'outline', size: 'sm' })}>Manage Gmail</Link>
          </CardContent>
        </Card>}
        <div className="mb-4">
          <h2 id="available-connections-heading" className="text-lg font-semibold">Import & export</h2>
          <p className="mt-1 text-sm text-muted-foreground">Choose a transfer method.</p>
        </div>
        <div className="grid gap-4 lg:grid-cols-2 stagger-children">
          {data.capabilities.map((capability) => {
            const Icon = CAPABILITY_ICONS[capability.id];
            return (
              <Card key={capability.id} className="border-border/70 shadow-card">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3">
                      <div className="rounded-xl bg-primary/10 p-2.5 text-primary">
                        <Icon className="h-5 w-5" aria-hidden="true" />
                      </div>
                      <div>
                        <CardTitle className="text-base">{capability.label}</CardTitle>
                        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{capability.description}</p>
                      </div>
                    </div>
                    <span className={`flex-shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                      capability.status === 'available'
                        ? 'border-emerald-200 bg-success-soft text-success'
                        : 'border-amber-200 bg-warning-soft text-amber-700'
                    }`}>
                      {capability.status === 'available' ? 'Available' : 'Optional'}
                    </span>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="rounded-xl border border-border/60 bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
                    {capability.privacy}
                  </div>
                  <Link href={capability.href} className={buttonVariants({ variant: 'outline', size: 'sm', className: 'w-full' })}>
                    {capability.actionLabel}
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      <details className="rounded-xl border border-border bg-card px-4">
        <summary className="min-h-12 cursor-pointer py-3 text-sm font-medium">How your data is handled</summary>
      <Card className="overflow-hidden border-border/70 shadow-card animate-fade-in-up">
        <div className="h-1 bg-primary/15" />
        <CardContent className="grid gap-4 pt-6 md:grid-cols-3">
          <div className="rounded-xl border border-border/60 bg-card/80 p-4">
            <HardDrive className="h-5 w-5 text-emerald-600" aria-hidden="true" />
            <p className="mt-3 text-sm font-semibold">{data.workspace?.mode === 'cloud' ? 'Cloud workspace' : 'Local workspace'}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {data.workspace?.name || 'My Everclose CRM'} stores its CRM data in this deployment.
            </p>
          </div>
          <div className="rounded-xl border border-border/60 bg-card/80 p-4">
            <ShieldCheck className="h-5 w-5 text-amber-600" aria-hidden="true" />
            <p className="mt-3 text-sm font-semibold">Explicit transfers</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Imports, exports, and restores happen only when you start them.
            </p>
          </div>
          <div className="rounded-xl border border-border/60 bg-card/80 p-4">
            <CloudOff className="h-5 w-5 text-rose-600" aria-hidden="true" />
            <p className="mt-3 text-sm font-semibold">Automatic account sync is off</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Accounts never import contacts, email, or calendar events without a separate connection and import choice.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="border border-amber-200/70 bg-warning-soft/40 shadow-sm">
        <CardContent className="flex gap-3 py-5">
          <CloudOff className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-700" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold">No hidden cloud connection</p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{data.automaticAccountSync.message}</p>
          </div>
        </CardContent>
      </Card>
      </details>
    </div>
  );
}
