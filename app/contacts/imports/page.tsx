'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, FileText } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { getResponseErrorMessage } from '@/lib/utils';
import type { ImportJobState } from '@/lib/import-report';

type Job = { id: string; filename: string; format: string; total: number; state: ImportJobState; created_at: string };
const labels: Record<ImportJobState, string> = { preparing: 'Preview not finished', review: 'Ready for your review', importing: 'Resume import', complete: 'Complete', cancelled: 'Cancelled' };

export default function ImportsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    fetch('/api/import/jobs', { cache: 'no-store', signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not load import reports.'));
      const data = await response.json();
      if (!controller.signal.aborted) setJobs(data.jobs);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Could not load import reports.');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);
  return <div className="mx-auto max-w-3xl space-y-6">
    <Link href="/contacts" className="inline-flex items-center gap-2 text-sm text-muted-foreground"><ArrowLeft className="h-4 w-4" />Your people</Link>
    <header><h1 className="text-2xl font-bold sm:text-3xl">Import reports</h1><p className="mt-2 text-sm text-muted-foreground">Review a file, finish an interrupted import, or see exactly what was saved.</p></header>
    {loading && <p role="status">Loading reports...</p>}
    {error && <div role="alert" className="rounded-xl border border-red-200 bg-danger-soft p-4 text-destructive"><p>{error}</p><Button className="mt-3" variant="outline" onClick={() => setReload((value) => value + 1)}>Try again</Button></div>}
    {!loading && !error && !jobs.length && <div className="rounded-2xl border border-dashed p-8 text-center"><FileText className="mx-auto h-8 w-8 text-muted-foreground" /><h2 className="mt-4 font-semibold">Your next import starts with a preview</h2><p className="mt-2 text-sm text-muted-foreground">Choose a CSV or vCard from the transfer panel in People.</p><Link href="/contacts" className={buttonVariants({ className: 'mt-4' })}>Go to People</Link></div>}
    {!error && jobs.map((job) => <Link key={job.id} href={`/contacts/imports/${job.id}`} className="flex items-center gap-4 rounded-xl border border-border/70 bg-card p-5 hover:border-primary/40">
      <FileText className="h-5 w-5 shrink-0 text-primary" /><div className="min-w-0 flex-1"><h2 className="break-words font-semibold">{job.filename}</h2><p className="mt-1 text-sm text-muted-foreground">{job.total.toLocaleString()} rows · {new Date(job.created_at).toLocaleDateString()}</p><p className="mt-2 text-sm font-medium">{labels[job.state]}</p></div><ArrowRight className="h-4 w-4 shrink-0" />
    </Link>)}
    <p className="text-xs leading-relaxed text-muted-foreground">Up to 20 reports and 50 MB of original files are retained in your cloud workspace. Remove a report to remove its original file; imported contacts remain. Imports only advance while the report page is running.</p>
  </div>;
}
