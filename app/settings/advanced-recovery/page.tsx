'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, CheckCircle2, DatabaseBackup, Pause, Play, RefreshCw, RotateCcw,
  ShieldCheck, Trash2, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { LoadError } from '@/components/ui/load-error';
import { useToast } from '@/components/ui/toast';
import { getResponseErrorMessage } from '@/lib/utils';

type Capture = {
  id: string;
  state: 'capturing' | 'awaiting_verification' | 'manifest_ready' | 'invalid';
  contactCount: number;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
};

type Restore = {
  id: string;
  state: 'preparing' | 'ready' | 'deleting' | 'awaiting_write' | 'writing' | 'repairing_dates'
    | 'verifying' | 'completed' | 'rolled_back' | 'invalid';
  source: 'target' | 'rollback';
  background: 'idle' | 'running' | 'paused' | 'failed' | 'complete';
  targetCaptureId: string;
  rollbackAvailable: boolean;
  tableIndex: number;
  chunkIndex: number;
  rowIndex: number;
  createdAt: string;
  updatedAt: string;
};

type RecoveryStatus = { enabled: boolean; captures: Capture[]; restore: Restore | null };
type StepResult = { capture?: Capture; restore?: Restore };
type Confirmation = { kind: 'prepare' | 'apply' | 'rollback' | 'delete'; id: string };

const API = '/api/settings/large-recovery';
const runningRestoreStates = new Set<Restore['state']>([
  'preparing', 'deleting', 'awaiting_write', 'writing', 'repairing_dates', 'verifying',
]);

function stamp(value: string): string {
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function phase(restore: Restore): string {
  if (restore.state === 'preparing') return 'Verifying both the selected snapshot and a new pre-restore recovery point';
  if (restore.state === 'ready') return 'Ready to apply. Your current data has not been replaced.';
  if (restore.state === 'deleting') return 'Replacing old CRM records in bounded batches';
  if (restore.state === 'awaiting_write' || restore.state === 'writing') return 'Writing verified snapshot records';
  if (restore.state === 'repairing_dates') return 'Restoring contact history timestamps';
  if (restore.state === 'verifying') return 'Comparing every restored row and checking relationships';
  if (restore.state === 'rolled_back') return 'The pre-restore data was verified and restored.';
  return 'The selected snapshot was verified and restored.';
}

function confirmationPhrase(kind: Confirmation['kind']): string {
  if (kind === 'prepare') return 'PREPARE';
  if (kind === 'apply') return 'RESTORE';
  if (kind === 'rollback') return 'ROLL BACK';
  return 'DELETE SNAPSHOT';
}

async function fetchStatus(signal?: AbortSignal): Promise<RecoveryStatus> {
  const response = await fetch(API, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not load recovery status'));
  return response.json() as Promise<RecoveryStatus>;
}

export default function AdvancedRecoveryPage() {
  const [status, setStatus] = useState<RecoveryStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [confirmationText, setConfirmationText] = useState('');
  const { toast } = useToast();
  const restoreId = status?.restore?.id;
  const restoreState = status?.restore?.state;
  const restoreBackground = status?.restore?.background;

  async function refresh() {
    const next = await fetchStatus();
    setStatus(next);
    return next;
  }

  useEffect(() => {
    const controller = new AbortController();
    fetchStatus(controller.signal).then((next) => {
      setStatus(next);
      const active = next.restore?.state === 'preparing'
        ? next.restore.id
        : next.captures.find((capture) => capture.state === 'capturing'
          || capture.state === 'awaiting_verification')?.id;
      if (active) setRunningId(active);
      setError(null);
    }).catch((reason) => {
      if (reason instanceof DOMException && reason.name === 'AbortError') return;
      setError(reason instanceof Error ? reason.message : 'Could not load recovery status');
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!restoreId || !restoreState || restoreState === 'preparing' || restoreState === 'ready'
      || !runningRestoreStates.has(restoreState) || restoreBackground !== 'running') return;
    let live = true;
    let pending = false;
    const timer = window.setInterval(() => {
      if (pending) return;
      pending = true;
      void fetchStatus().then((next) => {
        if (!live) return;
        setStatus(next);
        if (next.restore?.state === 'completed') {
          toast({ message: 'Recovery verified. Email alerts remain off until you re-enable them.' });
        } else if (next.restore?.state === 'rolled_back') {
          toast({ message: 'Pre-restore data verified and restored.' });
        }
      }).catch((reason) => {
        if (live) setError(reason instanceof Error ? reason.message : 'Could not refresh recovery progress');
      }).finally(() => { pending = false; });
    }, 2500);
    return () => { live = false; window.clearInterval(timer); };
  }, [restoreId, restoreState, restoreBackground, toast]);

  useEffect(() => {
    if (!runningId) return;
    let live = true;
    const controller = new AbortController();
    async function advance() {
      while (live) {
        const response = await fetch(`${API}/${runningId}/step`, { method: 'POST', signal: controller.signal });
        if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Recovery step failed'));
        const result = await response.json() as StepResult;
        if (!live) return;
        setStatus((previous) => previous ? {
          ...previous,
          restore: result.restore || previous.restore,
          captures: result.capture ? previous.captures.map((item) => item.id === result.capture!.id
            ? result.capture! : item) : previous.captures,
        } : previous);
        const pending = result.restore ? runningRestoreStates.has(result.restore.state)
          : result.capture?.state === 'capturing' || result.capture?.state === 'awaiting_verification';
        if (!pending) {
          setRunningId(null);
          setStatus(await fetchStatus());
          if (result.restore?.state === 'completed') {
            toast({ message: 'Recovery verified. Email alerts remain off until you re-enable them.' });
          } else if (result.restore?.state === 'rolled_back') {
            toast({ message: 'Pre-restore data verified and restored.' });
          } else if (result.capture?.state === 'manifest_ready') {
            toast({ message: 'Large cloud snapshot verified and ready.' });
          }
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 120));
      }
    }
    void advance().catch((reason) => {
      if (!live || reason instanceof DOMException && reason.name === 'AbortError') return;
      setError(reason instanceof Error ? reason.message : 'Recovery step failed');
      setRunningId(null);
    });
    return () => { live = false; controller.abort(); };
  }, [runningId, toast]);

  async function action(path: string, method: 'POST' | 'DELETE', body?: Record<string, string>) {
    setBusyAction(path);
    setError(null);
    try {
      const response = await fetch(path, {
        method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Recovery action failed'));
      const result = await response.json() as StepResult & { pending?: boolean };
      await refresh();
      setConfirmation(null);
      setConfirmationText('');
      if (result.capture && result.capture.state !== 'manifest_ready') setRunningId(result.capture.id);
      if (result.restore?.state === 'preparing') setRunningId(result.restore.id);
      if (result.pending) toast({ message: 'Snapshot removal is still in progress. Refresh to check its status.' });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Recovery action failed');
      try { await refresh(); } catch { /* Keep the actionable error if status is unavailable. */ }
    } finally {
      setBusyAction(null);
    }
  }

  function ask(kind: Confirmation['kind'], id: string) {
    setConfirmation({ kind, id });
    setConfirmationText('');
  }

  function confirmAction() {
    if (!confirmation || confirmationText !== confirmationPhrase(confirmation.kind)) return;
    const { kind, id } = confirmation;
    if (kind === 'prepare') {
      void action(API, 'POST', { action: 'prepare', targetCaptureId: id, confirmation: 'PREPARE' });
    } else if (kind === 'apply') {
      void action(`${API}/${id}/apply`, 'POST', { confirmation: 'RESTORE' });
    } else if (kind === 'rollback') {
      void action(`${API}/${id}/rollback`, 'POST', { confirmation: 'ROLL BACK' });
    } else {
      void action(`${API}/${id}`, 'DELETE', { confirmation: 'DELETE SNAPSHOT' });
    }
  }

  const restore = status?.restore;
  const activeRestore = Boolean(restore && (runningRestoreStates.has(restore.state) || restore.state === 'ready'));
  const activeCapture = status?.captures.find((capture) => capture.state === 'capturing'
    || capture.state === 'awaiting_verification');
  const canCreate = status?.enabled && !activeRestore && !activeCapture && !runningId && !busyAction;
  const isApplying = restore && restore.state !== 'preparing' && restore.state !== 'ready'
    && runningRestoreStates.has(restore.state);
  const phrase = confirmation ? confirmationPhrase(confirmation.kind) : '';

  return (
    <div className="space-y-6 pb-12">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Link href="/settings" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> Data & recovery
          </Link>
          <div className="mt-4 flex items-center gap-3">
            <DatabaseBackup className="h-7 w-7 text-primary" />
            <h1 className="text-2xl font-bold sm:text-3xl">Advanced recovery</h1>
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Create verified private cloud snapshots and restore large workspaces in resumable steps.
            Ordinary CRM access pauses while a restore is being applied or rolled back.
          </p>
        </div>
        <Button variant="outline" onClick={() => void refresh().catch((reason) =>
          setError(reason instanceof Error ? reason.message : 'Refresh failed'))} disabled={loading}>
          <RefreshCw className="h-4 w-4" /> Refresh status
        </Button>
      </div>

      {loading && <div className="skeleton h-52 rounded-xl" aria-label="Loading recovery status" />}
      {!loading && !status && <LoadError title="Recovery status is unavailable"
        message={error || 'Try again before starting an operation.'}
        onRetry={() => { setLoading(true); void refresh().then(() => setError(null))
          .catch((reason) => setError(reason instanceof Error ? reason.message : 'Refresh failed'))
          .finally(() => setLoading(false)); }} />}
      {status && !status.enabled && !activeRestore && (
        <div className="rounded-xl border border-amber-200 bg-warning-soft p-4 text-sm text-amber-950">
          Advanced recovery is not enabled for this workspace. The standard backup and restore options remain available in Data & recovery.
        </div>
      )}
      {error && status && (
        <div role="alert" className="rounded-xl border border-red-200 bg-danger-soft p-4 text-sm text-red-950">
          <p className="font-semibold">The current step needs attention.</p>
          <p className="mt-1">{error} {restore && isApplying
            ? 'Your workspace remains locked until application or rollback completes.'
            : 'No CRM data was replaced by this step.'}</p>
        </div>
      )}

      {status && (status.enabled || activeRestore) && (
        <>
          {restore && (
            <Card className={`border shadow-sm ${isApplying ? 'border-amber-300 bg-warning-soft/50' : 'border-border'}`}>
              <CardHeader>
                <div className="flex items-start gap-3">
                  {restore.state === 'completed' || restore.state === 'rolled_back'
                    ? <CheckCircle2 className="mt-0.5 h-5 w-5 text-success" />
                    : <ShieldCheck className="mt-0.5 h-5 w-5 text-amber-700" />}
                  <div>
                    <CardTitle className="text-lg">{restore.state === 'rolled_back' ? 'Rollback complete'
                      : restore.state === 'completed' ? 'Restore complete' : 'Current restore'}</CardTitle>
                    <p className="mt-1 text-sm text-muted-foreground">{phase(restore)}</p>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="rounded-full bg-card px-3 py-1.5 font-medium capitalize shadow-sm">{restore.state.replaceAll('_', ' ')}</span>
                  {isApplying && <span className="rounded-full bg-card px-3 py-1.5 shadow-sm">
                    {restore.source === 'rollback' ? 'Rolling back' : 'Applying snapshot'} · chunk {restore.chunkIndex + 1}
                  </span>}
                  <span className="rounded-full bg-card px-3 py-1.5 shadow-sm">Updated {stamp(restore.updatedAt)}</span>
                </div>
                {restore.state === 'ready' && (
                  <p className="rounded-lg border border-emerald-200 bg-success-soft p-3 text-sm text-emerald-950">
                    The selected snapshot and your current data have both been verified. Nothing has been replaced yet.
                  </p>
                )}
                {isApplying && restore.background === 'running' && (
                  <p className="rounded-lg border border-amber-200 bg-card/80 p-3 text-sm text-amber-950">
                    Recovery is progressing in the background. You can leave this page; your CRM remains unavailable until verification finishes.
                  </p>
                )}
                {isApplying && restore.background === 'paused' && (
                  <p className="rounded-lg border border-amber-200 bg-card/80 p-3 text-sm text-amber-950">
                    Recovery is paused on the server. A step already in progress may finish; your CRM remains locked until you resume or roll back.
                  </p>
                )}
                {isApplying && restore.background === 'failed' && (
                  <p role="alert" className="rounded-lg border border-red-200 bg-danger-soft p-3 text-sm text-red-950">
                    Background progress stopped after repeated errors. Resume to retry or roll back to the verified pre-restore data.
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {restore.state === 'ready' && status.enabled && (
                    <Button variant="destructive" onClick={() => ask('apply', restore.id)} disabled={busyAction !== null}>
                      Apply verified snapshot
                    </Button>
                  )}
                  {restore.state === 'ready' && (
                    <Button variant="outline" onClick={() => void action(`${API}/${restore.id}/cancel`, 'POST')}
                      disabled={busyAction !== null}>Cancel preparation</Button>
                  )}
                  {restore.state === 'preparing' && runningId === restore.id && (
                    <Button variant="outline" onClick={() => setRunningId(null)}><Pause className="h-4 w-4" /> Pause preparation</Button>
                  )}
                  {restore.state === 'preparing' && runningId !== restore.id && (
                    <Button variant="secondary" onClick={() => { setError(null); setRunningId(restore.id); }}
                      disabled={busyAction !== null}><Play className="h-4 w-4" /> Resume preparation</Button>
                  )}
                  {isApplying && restore.background === 'running' && (
                    <Button variant="outline" onClick={() => void action(`${API}/${restore.id}/pause`, 'POST')}
                      disabled={busyAction !== null}><Pause className="h-4 w-4" /> Pause recovery</Button>
                  )}
                  {isApplying && (restore.background === 'paused' || restore.background === 'failed') && (
                    <Button variant="secondary" onClick={() => void action(`${API}/${restore.id}/resume`, 'POST')}
                      disabled={busyAction !== null}><Play className="h-4 w-4" /> Resume recovery</Button>
                  )}
                  {isApplying && restore.source === 'target' && restore.rollbackAvailable
                    && (restore.background === 'paused' || restore.background === 'failed') && (
                    <Button variant="outline" onClick={() => ask('rollback', restore.id)} disabled={busyAction !== null}>
                      <RotateCcw className="h-4 w-4" /> Roll back to previous data
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          <Card className="border-border/70 shadow-card">
            <CardHeader>
              <CardTitle className="text-lg">Private snapshots</CardTitle>
              <p className="text-sm text-muted-foreground">
                These verified snapshots stay in your workspace&apos;s private cloud storage. They are not downloadable files.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button onClick={() => void action(API, 'POST', { action: 'capture' })} disabled={!canCreate}>
                {busyAction === API ? <RefreshCw className="h-4 w-4 animate-spin" /> : <DatabaseBackup className="h-4 w-4" />}
                Capture a large snapshot
              </Button>
              {status.captures.length === 0 ? (
                <div className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
                  No large snapshots yet. Capture one to create a verified recovery point.
                </div>
              ) : (
                <div className="divide-y divide-border/70">
                  {status.captures.map((capture) => (
                    <div key={capture.id} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="font-medium">{stamp(capture.createdAt)}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {capture.contactCount} contacts · {capture.chunkCount} chunks · {capture.state.replaceAll('_', ' ')}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {capture.state !== 'manifest_ready' && runningId !== capture.id && (
                          <Button size="sm" variant="secondary" onClick={() => { setError(null); setRunningId(capture.id); }}>
                            <Play className="h-3.5 w-3.5" /> Resume
                          </Button>
                        )}
                        {capture.state === 'manifest_ready' && (
                          <Button size="sm" variant="secondary" onClick={() => ask('prepare', capture.id)}
                            disabled={!canCreate}>Prepare restore</Button>
                        )}
                        {capture.state === 'manifest_ready' && (
                          <Button size="sm" variant="ghost" onClick={() => ask('delete', capture.id)}
                            disabled={Boolean(activeRestore) || busyAction !== null} aria-label={`Delete snapshot from ${stamp(capture.createdAt)}`}>
                            <Trash2 className="h-3.5 w-3.5" /> Remove
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/30 p-4 text-xs leading-relaxed text-muted-foreground">
            <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <p>The standard encrypted-download backups remain separate. A large private snapshot is only a recovery point inside this cloud workspace; keep an independent export when you need an off-device copy.</p>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirmation !== null}
        title={confirmation?.kind === 'apply' ? 'Apply this snapshot?'
          : confirmation?.kind === 'rollback' ? 'Restore the previous data?'
            : confirmation?.kind === 'delete' ? 'Remove this private snapshot?' : 'Prepare this restore?'}
        description={confirmation?.kind === 'apply'
          ? 'Current CRM data will be replaced in bounded steps. The workspace will be locked until every restored row is verified.'
          : confirmation?.kind === 'rollback'
            ? 'The partially applied snapshot will be replaced with the verified pre-restore data.'
            : confirmation?.kind === 'delete'
              ? 'This removes the snapshot from private cloud storage. It cannot be recovered afterward.'
              : 'We will verify the selected snapshot and capture your current CRM as a rollback point before any data is replaced.'}
        safetyNote={confirmation?.kind === 'delete'
          ? 'Removing an unprotected snapshot cannot be undone.'
          : 'Your workspace stays locked during replacement. If an application step fails, pause it and roll back to the pre-restore point.'}
        safetyTone={confirmation?.kind === 'delete' ? 'irreversible' : 'recovery'}
        confirmLabel={confirmation?.kind === 'delete' ? 'Remove snapshot'
          : confirmation?.kind === 'rollback' ? 'Start rollback'
            : confirmation?.kind === 'apply' ? 'Start restore' : 'Prepare restore'}
        pending={busyAction !== null}
        confirmDisabled={confirmationText !== phrase}
        onCancel={() => setConfirmation(null)}
        onConfirm={confirmAction}
      >
        <div className="mt-4 space-y-1.5">
          <label htmlFor="advanced-recovery-confirmation" className="text-sm font-medium">
            Type <span className="font-mono">{phrase}</span> to continue
          </label>
          <Input id="advanced-recovery-confirmation" value={confirmationText}
            onChange={(event) => setConfirmationText(event.target.value)} autoComplete="off" spellCheck={false} />
        </div>
      </ConfirmDialog>
    </div>
  );
}
