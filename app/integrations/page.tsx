'use client';

import { useEffect, useState } from 'react';
import { Clock3, PlugZap, ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type IntegrationSnapshot = {
  id: number;
  provider: string;
  label: string;
  status: 'connected' | 'attention' | 'disconnected';
  account_email: string | null;
  last_synced_at: string | null;
  sync_frequency_minutes: number;
  latest_job: {
    status: string;
    summary: string | null;
    started_at: string;
    finished_at: string | null;
  } | null;
};

type IntegrationResponse = {
  workspace?: {
    name: string;
    plan: string;
  };
  integrations: IntegrationSnapshot[];
};

function getStatusClasses(status: IntegrationSnapshot['status']) {
  if (status === 'connected') return 'bg-emerald-50 text-emerald-700 border-emerald-200/60';
  if (status === 'attention') return 'bg-amber-50 text-amber-700 border-amber-200/60';
  return 'bg-slate-50 text-slate-700 border-slate-200/60';
}

export default function IntegrationsPage() {
  const [data, setData] = useState<IntegrationResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchIntegrations() {
      try {
        const res = await fetch('/api/integrations', { cache: 'no-store' });
        const next = await res.json() as IntegrationResponse;
        setData(next);
      } catch (error) {
        console.error('Failed to fetch integrations:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchIntegrations();
  }, []);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <div className="skeleton h-9 w-52" />
          <div className="skeleton h-5 w-80" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {[1, 2, 3, 4].map((index) => (
            <div key={index} className="skeleton h-48 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  const integrations = data?.integrations || [];

  return (
    <div className="space-y-6">
      <div className="animate-fade-in">
        <div className="flex items-center gap-2">
          <PlugZap className="w-5 h-5 text-primary" />
          <h1 className="text-2xl sm:text-3xl font-bold">Integrations</h1>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Automation status, sync readiness, and the systems that will eventually keep Bonds updated for you.
        </p>
      </div>

      <Card className="border-0 shadow-sm animate-fade-in-up">
        <CardContent className="pt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="rounded-xl border border-border/60 bg-white/80 p-4">
            <p className="text-sm font-medium">Workspace</p>
            <p className="text-xs text-muted-foreground mt-1">{data?.workspace?.name || 'Bonds HQ'}</p>
          </div>
          <div className="rounded-xl border border-border/60 bg-white/80 p-4">
            <p className="text-sm font-medium">Plan</p>
            <p className="text-xs text-muted-foreground mt-1 capitalize">{data?.workspace?.plan || 'premium'}</p>
          </div>
          <div className="rounded-xl border border-border/60 bg-white/80 p-4">
            <p className="text-sm font-medium">Trust posture</p>
            <p className="text-xs text-muted-foreground mt-1">Single-user, migration-era local workspace with V2 sync scaffolding.</p>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 stagger-children">
        {integrations.map((integration) => (
          <Card key={integration.id} className="border-0 shadow-sm">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-base font-semibold">{integration.label}</CardTitle>
                  <p className="text-sm text-muted-foreground mt-1">
                    {integration.account_email || integration.latest_job?.summary || 'No account linked yet'}
                  </p>
                </div>
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${getStatusClasses(integration.status)}`}>
                  {integration.status}
                </span>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Clock3 className="w-4 h-4" />
                  Sync cadence: every {integration.sync_frequency_minutes} minutes
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <ShieldCheck className="w-4 h-4" />
                  Last sync: {integration.last_synced_at ? new Date(integration.last_synced_at).toLocaleString() : 'Not synced yet'}
                </div>
              </div>

              {integration.latest_job && (
                <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
                  <p className="text-sm font-medium">Latest job</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {integration.latest_job.summary || integration.latest_job.status}
                  </p>
                </div>
              )}

              <Button variant={integration.status === 'connected' ? 'secondary' : 'outline'} size="sm" className="w-full" disabled>
                {integration.status === 'connected' ? 'Connected in this foundation slice' : 'Connection flow coming next'}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
