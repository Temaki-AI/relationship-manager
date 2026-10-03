'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Download, FileText, RefreshCw, Trash2 } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { getResponseErrorMessage } from '@/lib/utils';

type ExportJob = {
  id: string;
  format: 'csv' | 'vcard';
  state: 'running' | 'finalizing' | 'complete' | 'invalid' | 'deleting';
  total: number;
  exported: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

function jobLabel(job: ExportJob): string {
  if (new Date(job.expiresAt).getTime() <= Date.now()) return 'Expired';
  if (job.state === 'finalizing') return 'Putting the file together';
  if (job.state === 'complete') return 'Ready to download';
  if (job.state === 'invalid') return 'Workspace changed; start a new export';
  if (job.state === 'deleting') return 'Removing stored file';
  return `${job.exported.toLocaleString()} of ${job.total.toLocaleString()} contacts prepared`;
}

export default function ContactExportsPage() {
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [creating, setCreating] = useState<'csv' | 'vcard' | null>(null);
  const [createAttempt, setCreateAttempt] = useState<{ format: 'csv' | 'vcard'; key: string } | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch('/api/export/jobs', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not load exports.'));
        const body = await response.json();
        if (!controller.signal.aborted) { setJobs(body.jobs); setError(null); }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not load exports.');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    if (!runningId) return;
    const controller = new AbortController();
    const run = async () => {
      try {
        while (!controller.signal.aborted) {
          const response = await fetch(`/api/export/jobs/${runningId}`, { method: 'POST', cache: 'no-store', signal: controller.signal });
          if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Export could not continue.'));
          const body = await response.json();
          const job = body.job as ExportJob;
          if (controller.signal.aborted) return;
          setJobs((current) => current.map((item) => item.id === job.id ? job : item));
          if (job.state !== 'running' && job.state !== 'finalizing') break;
        }
        if (!controller.signal.aborted) setRunningId(null);
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : 'Export could not continue.');
          setRunningId(null);
        }
      }
    };
    void run();
    return () => controller.abort();
  }, [runningId]);

  const create = async (format: 'csv' | 'vcard') => {
    const attempt = createAttempt?.format === format ? createAttempt : { format, key: crypto.randomUUID() };
    setCreateAttempt(attempt);
    setCreating(format);
    setError(null);
    try {
      const response = await fetch('/api/export/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': attempt.key },
        body: JSON.stringify({ format }), cache: 'no-store',
      });
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not create export.'));
      const body = await response.json();
      const job = body.job as ExportJob;
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      setCreateAttempt(null);
      if (job.state === 'running' || job.state === 'finalizing') setRunningId(job.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create export. Retry with the same request.');
    } finally { setCreating(null); }
  };

  const remove = async (id: string) => {
    setRemovingId(id);
    setError(null);
    try {
      for (let attempt = 0; attempt < 20; attempt++) {
        const response = await fetch(`/api/export/jobs/${id}`, { method: 'DELETE', cache: 'no-store' });
        if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not remove export.'));
        if (response.status !== 202) {
          setJobs((current) => current.filter((job) => job.id !== id));
          return;
        }
      }
      setError('Export removal is still in progress. Choose Remove again to finish.');
      setJobs((current) => current.map((job) => job.id === id ? { ...job, state: 'deleting' } : job));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not remove export.');
    } finally { setRemovingId(null); }
  };

  if (process.env.NEXT_PUBLIC_AUTH_MODE !== 'google') {
    return <div className="mx-auto max-w-3xl"><p>Cloud exports are available in the signed-in workspace. Local contact downloads are in People.</p><Link href="/contacts" className="text-primary underline">Back to People</Link></div>;
  }

  return <div className="mx-auto max-w-3xl space-y-6">
    <Link href="/contacts" className="inline-flex items-center gap-2 text-sm text-muted-foreground"><ArrowLeft className="h-4 w-4" />Your people</Link>
    <header>
      <h1 className="text-2xl font-bold sm:text-3xl">Contact exports</h1>
      <p className="mt-2 text-sm text-muted-foreground">Prepare a complete contacts file, even for a large workspace. Keep your workspace unchanged while the export runs.</p>
    </header>
    <div className="rounded-2xl border border-border/70 bg-white p-5 sm:p-6">
      <h2 className="font-semibold">Create an export</h2>
      <p className="mt-1 text-sm text-muted-foreground">The page prepares small batches and saves progress. You can leave and resume later. Downloads expire after six days, and expired files are scheduled for removal. You can remove them sooner.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button disabled={Boolean(creating || runningId)} onClick={() => void create('vcard')}><FileText className="h-4 w-4" />{creating === 'vcard' ? 'Starting...' : 'Prepare vCard'}</Button>
        <Button variant="outline" disabled={Boolean(creating || runningId)} onClick={() => void create('csv')}><FileText className="h-4 w-4" />{creating === 'csv' ? 'Starting...' : 'Prepare CSV'}</Button>
      </div>
      {createAttempt && <p className="mt-3 text-xs text-muted-foreground">If starting failed, choose {createAttempt.format === 'csv' ? 'Prepare CSV' : 'Prepare vCard'} again to retry the same request safely.</p>}
    </div>
    {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900"><p>{error}</p><Button className="mt-3" variant="outline" onClick={() => setReload((value) => value + 1)}><RefreshCw className="h-4 w-4" />Refresh status</Button></div>}
    {loading && <p role="status">Loading exports...</p>}
    {!loading && !jobs.length && <div className="rounded-2xl border border-dashed p-8 text-center"><Download className="mx-auto h-8 w-8 text-muted-foreground" /><h2 className="mt-4 font-semibold">No exports yet</h2><p className="mt-2 text-sm text-muted-foreground">Choose a format above to make your first contacts file.</p></div>}
    {jobs.map((job) => {
      const expired = new Date(job.expiresAt).getTime() <= Date.now();
      const active = job.state === 'running' || job.state === 'finalizing';
      return <article key={job.id} className="rounded-2xl border border-border/70 bg-white p-5 sm:p-6">
        <div className="flex items-start gap-3"><FileText className="mt-0.5 h-5 w-5 shrink-0 text-primary" /><div className="min-w-0 flex-1">
          <h2 className="font-semibold">{job.format === 'csv' ? 'CSV' : 'vCard'} contacts</h2>
          <p className="mt-1 text-sm text-muted-foreground">{job.total.toLocaleString()} contacts · Started {new Date(job.createdAt).toLocaleDateString()}</p>
          <p className="mt-2 text-sm font-medium" role="status">{jobLabel(job)}</p>
        </div></div>
        {active && <progress aria-label={`${job.format} export progress`} value={job.exported} max={Math.max(1, job.total)} className="mt-4 h-2 w-full" />}
        <div className="mt-4 flex flex-wrap gap-2">
          {active && !expired && <Button variant="outline" disabled={Boolean(runningId || removingId)} onClick={() => { setError(null); setRunningId(job.id); }}>{runningId === job.id ? 'Preparing...' : 'Resume export'}</Button>}
          {job.state === 'complete' && !expired && <a href={`/api/export/jobs/${job.id}/download`} download className={buttonVariants({ size: 'sm' })}><Download className="h-4 w-4" />Download</a>}
          <Button variant="outline" size="sm" disabled={Boolean(runningId || removingId)} onClick={() => void remove(job.id)}><Trash2 className="h-4 w-4" />{removingId === job.id ? 'Removing...' : 'Remove'}</Button>
        </div>
      </article>;
    })}
    <p className="text-xs leading-relaxed text-muted-foreground">These are contacts-only files, not full workspace backups. Relationships, children, history, plans, and reminders are not included. For a full workspace recovery copy, use Settings. No contact file is offered if the workspace changes during preparation.</p>
  </div>;
}
