'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, CheckCircle2, Download, FileText, Pause, Play, RefreshCw } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { IMPORT_ROW_STATES, IMPORT_STATE_LABELS, type ImportReport, type ImportRowState } from '@/lib/import-report';
import { getResponseErrorMessage } from '@/lib/utils';

export function ImportReportView({ id }: { id: string }) {
  const router = useRouter();
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [filter, setFilter] = useState<ImportRowState | 'all'>('all');
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [confirmation, setConfirmation] = useState<'remove' | 'cancel' | null>(null);
  const operation = useRef({ busy: false, stop: false, mounted: true });
  const endpoint = `/api/import/jobs/${encodeURIComponent(id)}?${new URLSearchParams({ page: String(page), filter })}`;

  useEffect(() => {
    const current = operation.current;
    current.mounted = true;
    return () => { current.mounted = false; current.stop = true; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(endpoint, { cache: 'no-store', signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not load this import report.'));
      const data: ImportReport = await response.json();
      if (!controller.signal.aborted) setReport(data);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Could not load this import report.');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [endpoint, reload]);

  async function send(body: Record<string, unknown>) {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Progress could not be saved. Refresh and resume safely.'));
    const next: ImportReport = await response.json();
    if (operation.current.mounted) setReport(next);
    return next;
  }

  async function run(body: Record<string, unknown>, continueBatches = false) {
    if (operation.current.busy) return;
    operation.current.busy = true;
    operation.current.stop = false;
    setBusy(true); setPausing(false); setError(null);
    try {
      let next = await send(body);
      while (continueBatches && !operation.current.stop && operation.current.mounted
        && (next.job.state === 'preparing' || next.job.state === 'importing')) {
        next = await send({ action: next.job.state === 'preparing' ? 'prepare' : 'advance' });
      }
    } catch (error) {
      if (operation.current.mounted) setError(error instanceof Error ? error.message : 'Progress could not be saved. Refresh before resuming.');
    } finally {
      operation.current.busy = false;
      if (operation.current.mounted) { setBusy(false); setPausing(false); setConfirmation(null); }
    }
  }

  async function remove() {
    if (operation.current.busy) return;
    operation.current.busy = true;
    setBusy(true);
    try {
      const response = await fetch(endpoint, { method: 'DELETE' });
      if (!response.ok && response.status !== 404) throw new Error(await getResponseErrorMessage(response, 'Could not remove the report.'));
      router.replace('/contacts/imports');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not remove the report.');
    } finally { operation.current.busy = false; setBusy(false); setConfirmation(null); }
  }

  const disabled = busy || loading || Boolean(error);
  const state = report?.job.state;
  const active = state === 'preparing' || state === 'review' || state === 'importing';
  const canDecide = state === 'review';
  const phase = state === 'preparing' ? 'Prepare your preview' : state === 'review' ? 'Choose who to bring in'
    : state === 'importing' ? 'Import in progress' : state === 'complete' ? 'Import complete' : 'Import cancelled';

  return (
    <div className="mx-auto max-w-4xl space-y-6 pb-8">
      <Link href="/contacts/imports" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" />Import reports</Link>
      <header className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-widest text-primary">Your people, your choice</p>
        <h1 className="text-2xl font-bold sm:text-3xl">{report ? phase : 'Import report'}</h1>
        {report && <p className="break-words text-sm text-muted-foreground">{report.job.filename} · {report.job.total.toLocaleString()} rows</p>}
      </header>
      {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
        <p>{error}</p><p className="mt-1">Refresh the saved report before trying again. Already imported rows will not be imported twice.</p>
        <Button className="mt-3" variant="outline" disabled={busy || loading} onClick={() => setReload((value) => value + 1)}><RefreshCw className="h-4 w-4" />Refresh report</Button>
      </div>}
      {loading && <p role="status" className="text-sm text-muted-foreground">Loading saved progress...</p>}
      {report && <>
        <section className="rounded-2xl border border-border/70 bg-white p-5 shadow-sm sm:p-6" aria-label="Import summary">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {IMPORT_ROW_STATES.map((value) => <div key={value}><p className="text-2xl font-semibold tabular-nums">{report.counts[value].toLocaleString()}</p><p className="text-sm text-muted-foreground">{IMPORT_STATE_LABELS[value]}</p></div>)}
          </div>
          <div className="mt-5 border-t border-border/60 pt-5">
            <p className="text-sm leading-relaxed text-muted-foreground">
              {state === 'preparing' ? 'Check the file first. No contacts are saved until you confirm the preview.'
                : state === 'review' ? 'Possible matches need your decision. Create a separate person or skip the row. Existing contacts are never overwritten.'
                : state === 'importing' ? 'Contacts are saved in small batches. You can pause or close this page and resume here later.'
                : state === 'complete' ? 'Every row has an outcome below. Invalid and skipped rows were not added.'
                : 'No more rows will be imported. Contacts already saved remain in your people list.'}
            </p>
            {active && <p className="mt-2 text-xs text-muted-foreground">Work only advances while this page is running. Up to one in-flight batch may finish after pausing or leaving.</p>}
            <div className="mt-4 flex flex-wrap gap-2">
              {state === 'preparing' && <Button disabled={disabled} onClick={() => void run({ action: 'prepare' }, true)}><FileText className="h-4 w-4" />Prepare preview</Button>}
              {state === 'review' && <Button disabled={disabled || report.counts.review > 0 || report.counts.pending > 0} onClick={() => void run({ action: 'confirm', confirm: true }, true)}>
                <CheckCircle2 className="h-4 w-4" />{report.counts.ready ? `Import ${report.counts.ready.toLocaleString()} contact${report.counts.ready === 1 ? '' : 's'}` : 'Finish report'}
              </Button>}
              {state === 'importing' && <Button disabled={disabled} onClick={() => void run({ action: 'advance' }, true)}><Play className="h-4 w-4" />Resume import</Button>}
              {busy && active && <Button variant="outline" disabled={pausing} onClick={() => { operation.current.stop = true; setPausing(true); }}><Pause className="h-4 w-4" />{pausing ? 'Pausing after this batch...' : 'Pause after this batch'}</Button>}
              {canDecide && report.counts.review > 0 && <Button variant="outline" disabled={disabled} onClick={() => void run({ action: 'skip-matches' })}>Skip possible matches ({report.counts.review})</Button>}
              {state === 'complete' && <Link href="/contacts" className={buttonVariants()}>View your people</Link>}
            </div>
            <p role="status" aria-live="polite" className="mt-3 text-sm text-muted-foreground">
              {busy ? state === 'preparing' ? `${report.job.total - report.counts.pending} of ${report.job.total} rows checked` : `${report.counts.imported} contacts saved` : state === 'importing' ? 'Paused. Resume when you are ready.' : ''}
            </p>
          </div>
        </section>
        <section aria-label="Row outcomes" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Every person accounted for</h2>
            <div className="flex items-center gap-2 text-sm"><label htmlFor="import-row-filter">Show</label>
              <select id="import-row-filter" value={filter} disabled={busy || loading} className="rounded-lg border border-input bg-background p-2" onChange={(event) => { setPage(1); setFilter(event.target.value as ImportRowState | 'all'); }}>
                <option value="all">All rows</option>{IMPORT_ROW_STATES.map((value) => <option key={value} value={value}>{IMPORT_STATE_LABELS[value]} ({report.counts[value]})</option>)}
              </select>
            </div>
          </div>
          {!report.rows.length && <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">No rows in this view.</p>}
          {report.rows.map((row) => <article key={row.row_number} className="rounded-xl border border-border/70 bg-white p-4">
            <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><h3 className="break-words font-semibold">{row.name}</h3><p className="mt-1 break-words text-xs text-muted-foreground">Row {row.row_number}{row.email && ` · ${row.email}`}{row.phone && ` · ${row.phone}`}{row.birthday && ` · Birthday ${row.birthday}`}</p></div>
              <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${row.state === 'review' || row.state === 'invalid' ? 'bg-amber-50 text-amber-900' : row.state === 'imported' ? 'bg-emerald-50 text-emerald-800' : 'bg-muted text-muted-foreground'}`}>{IMPORT_STATE_LABELS[row.state]}</span>
            </div>
            {row.message && <p className="mt-2 text-sm text-muted-foreground">{row.message}</p>}
            {!!row.matches.length && <p className="mt-2 text-sm">Possible existing matches: {row.matches.map((match, index) => <span key={match.id}>{index > 0 && ', '}<Link className="text-primary underline underline-offset-2" href={`/contacts/${match.id}`} target="_blank" rel="noopener noreferrer">{match.name} (opens new tab)</Link></span>)}</p>}
            {!!row.fileMatches.length && <p className="mt-2 text-sm text-muted-foreground">Possible matches in this file: {row.fileMatches.map((match) => `${match.name} (row ${match.row})`).join(', ')}. Up to five matches shown.</p>}
            {row.state === 'imported' && row.contact_id && <Link href={`/contacts/${row.contact_id}`} className="mt-2 inline-block text-sm text-primary underline underline-offset-2">Open imported contact</Link>}
            {canDecide && ['review', 'ready', 'skipped'].includes(row.state) && <div className="mt-3 flex flex-wrap gap-2">
              {row.state !== 'ready' && <Button size="sm" variant="outline" disabled={disabled} onClick={() => void run({ action: 'decide', rowNumber: row.row_number, decision: 'create' })}>Create separate contact</Button>}
              {row.state !== 'skipped' && <Button size="sm" variant="outline" disabled={disabled} onClick={() => void run({ action: 'decide', rowNumber: row.row_number, decision: 'skip' })}>Skip this row</Button>}
            </div>}
          </article>)}
          <div className="flex items-center justify-between gap-2">
            <Button variant="outline" disabled={busy || loading || report.pagination.page <= 1} onClick={() => setPage(report.pagination.page - 1)}>Previous</Button>
            <span className="text-sm text-muted-foreground">Page {report.pagination.page} of {report.pagination.totalPages}</span>
            <Button variant="outline" disabled={busy || loading || report.pagination.page >= report.pagination.totalPages} onClick={() => setPage(report.pagination.page + 1)}>Next</Button>
          </div>
        </section>
        <footer className="space-y-3 rounded-xl bg-muted/50 p-4">
          <p className="text-xs leading-relaxed text-muted-foreground">{report.retention} Reports and original files are not included in CRM backups. Keep a separate copy if you need them.</p>
          <div className="flex flex-wrap gap-3">
            <a href={`/api/import/jobs/${encodeURIComponent(id)}/source`} download className={buttonVariants({ variant: 'outline', size: 'sm' })}><Download className="h-4 w-4" />Original file</a>
            {active && <Button variant="outline" size="sm" disabled={disabled} onClick={() => setConfirmation('cancel')}>Cancel remaining import</Button>}
            <Button variant="ghost" size="sm" disabled={busy || loading} onClick={() => setConfirmation('remove')}>Remove report and original</Button>
          </div>
        </footer>
      </>}
      <ConfirmDialog open={confirmation !== null} title={confirmation === 'remove' ? 'Remove this report and original file?' : 'Cancel the remaining import?'}
        description={confirmation === 'remove' ? 'The saved report and uploaded file will be permanently removed. Any unfinished import will stop.' : 'Rows not yet imported will remain unsaved. You can still inspect the report and download the original.'}
        safetyNote="Already imported contacts will not be deleted. An in-flight batch may finish before this request reaches the server."
        safetyTone="irreversible" confirmLabel={confirmation === 'remove' ? 'Remove report and file' : 'Cancel import'} pending={busy}
        onCancel={() => setConfirmation(null)} onConfirm={() => confirmation === 'remove' ? void remove() : void run({ action: 'cancel' })} />
    </div>
  );
}
