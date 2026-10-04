'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArchiveRestore,
  DatabaseBackup,
  Download,
  HardDrive,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { LoadError } from '@/components/ui/load-error';
import { useToast } from '@/components/ui/toast';
import {
  decryptPortableBackup,
  encryptPortableBackup,
  getPortableBackupFilename,
  PORTABLE_BACKUP_MIME_TYPE,
  PORTABLE_BACKUP_MINIMUM_PASSPHRASE_LENGTH,
  PORTABLE_BACKUP_OVERHEAD_BYTES,
} from '@/lib/portable-backup';
import {
  BIRTHDAY_NOTIFICATION_LEDGER_KEY,
  REMINDER_NOTIFICATION_LEDGER_KEY,
  REMINDER_NOTIFICATION_PREFERENCE_KEY,
} from '@/lib/reminder-notifications';
import { getResponseErrorMessage } from '@/lib/utils';
import { WORKSPACE_ERASURE_CONFIRMATION } from '@/lib/workspace-erasure-contract';

type BackupReason = 'manual' | 'automatic' | 'pre-restore' | 'pre-merge' | 'pre-delete';

type BackupMetadata = {
  filename: string;
  createdAt: string;
  reason: BackupReason;
  schemaVersion: string;
  sizeBytes: number;
  sha256: string;
  rowCounts: Record<string, number>;
  protected?: boolean;
};

type BackupResponse = {
  mode?: 'cloud' | 'local';
  largeRecoveryEnabled?: boolean;
  lifecycle?: 'active' | 'erasing' | 'restoring';
  backups: BackupMetadata[];
  automaticBackup: {
    enabled: boolean;
    state: 'disabled' | 'current' | 'due' | 'failed';
    intervalHours: number;
    latestBackupAt: string | null;
    nextBackupAt: string | null;
    issue?: 'too_large' | 'backup_failed' | 'backup_missing' | null;
  };
  retentionCount: number;
  maxRestoreMegabytes: number;
};

type SettingsConfirmationTarget =
  | { kind: 'delete-backup'; backup: BackupMetadata }
  | { kind: 'restore-managed'; backup: BackupMetadata }
  | { kind: 'restore-upload' }
  | { kind: 'erase' };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units[0];

  for (let index = 1; index < units.length && value >= 1024; index++) {
    value /= 1024;
    unit = units[index];
  }

  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function formatBackupReason(reason: BackupReason): string {
  if (reason === 'automatic') return 'Automatic backup';
  if (reason === 'pre-restore') return 'Recovery point';
  if (reason === 'pre-merge') return 'Before duplicate merge';
  if (reason === 'pre-delete') return 'Before contact deletion';
  return 'Manual backup';
}

function formatBackupInterval(hours: number): string {
  if (hours === 1) return 'every hour';
  if (hours < 24) return `every ${hours} hours`;
  if (hours === 24) return 'daily';
  if (hours % 24 === 0) return `every ${hours / 24} days`;
  return `every ${hours} hours`;
}

function SettingsHeading({ cloud = false }: { cloud?: boolean }) {
  return (
    <div className="animate-fade-in">
      <div className="flex items-center gap-2">
        <HardDrive className="h-5 w-5 text-primary" />
        <h1 className="text-2xl font-bold sm:text-3xl">Data & recovery</h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {cloud ? 'Protect your private workspace with verified cloud recovery points and encrypted downloads.' : 'Protect your relationship history with verified backups and encrypted downloads.'}
      </p>
    </div>
  );
}

function SkeletonSettings() {
  return (
    <div className="space-y-6">
      <SettingsHeading />
      <div className="grid gap-4 md:grid-cols-3">
        <div className="skeleton h-36 rounded-xl md:col-span-2" />
        <div className="skeleton h-36 rounded-xl" />
      </div>
      <div className="skeleton h-64 rounded-xl" />
      <div className="skeleton h-72 rounded-xl" />
    </div>
  );
}

export default function SettingsPage() {
  const [data, setData] = useState<BackupResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [portablePassphrase, setPortablePassphrase] = useState('');
  const [portablePassphraseConfirmation, setPortablePassphraseConfirmation] = useState('');
  const [restorePassphrase, setRestorePassphrase] = useState('');
  const [erasureConfirmation, setErasureConfirmation] = useState('');
  const [confirmationTarget, setConfirmationTarget] = useState<SettingsConfirmationTarget | null>(null);
  const { toast } = useToast();
  const cloud = data?.mode === 'cloud';
  const erasing = data?.lifecycle === 'erasing';
  const restoring = data?.lifecycle === 'restoring';
  const recoveryUnavailable = busyAction !== null || erasing || restoring;

  async function loadBackups(signal?: AbortSignal) {
    const response = await fetch('/api/settings/backups', { cache: 'no-store', signal });
    if (!response.ok) {
      throw new Error(await getResponseErrorMessage(response, 'Failed to load backups'));
    }
    setData(await response.json() as BackupResponse);
  }

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    loadBackups(controller.signal)
      .then(() => setLoadError(null))
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setLoadError(error instanceof Error ? error.message : 'Failed to load backups');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadToken]);

  async function createBackup() {
    setBusyAction('create');
    try {
      const response = await fetch('/api/settings/backups', { method: 'POST' });
      if (!response.ok) {
        throw new Error(await getResponseErrorMessage(response, 'Failed to create backup'));
      }
      const next = await response.json() as BackupResponse;
      setData(next);
      toast({ message: 'Database backup created' });
    } catch (error) {
      toast({
        message: error instanceof Error ? error.message : 'Failed to create backup',
        variant: 'error',
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function deleteBackup(filename: string) {
    setBusyAction(`delete:${filename}`);
    try {
      const response = await fetch(`/api/settings/backups/${encodeURIComponent(filename)}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        throw new Error(await getResponseErrorMessage(response, 'Failed to delete backup'));
      }
      const next = await response.json() as Partial<BackupResponse> & Pick<BackupResponse, 'backups'>;
      setData((previous) => previous ? { ...previous, ...next } : previous);
      setConfirmationTarget(null);
      toast({ message: 'Backup deleted' });
    } catch (error) {
      toast({
        message: error instanceof Error ? error.message : 'Failed to delete backup',
        variant: 'error',
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function downloadEncryptedBackup(backup: BackupMetadata) {
    if (portablePassphrase.trim().length < PORTABLE_BACKUP_MINIMUM_PASSPHRASE_LENGTH) {
      toast({
        message: `Use a backup passphrase with at least ${PORTABLE_BACKUP_MINIMUM_PASSPHRASE_LENGTH} characters`,
        variant: 'error',
      });
      return;
    }
    if (portablePassphrase !== portablePassphraseConfirmation) {
      toast({ message: 'Backup passphrases do not match', variant: 'error' });
      return;
    }

    setBusyAction(`download:${backup.filename}`);
    try {
      const response = await fetch(`/api/settings/backups/${encodeURIComponent(backup.filename)}`, {
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(await getResponseErrorMessage(response, 'Failed to prepare backup'));
      }
      const plaintext = await response.arrayBuffer();
      if (plaintext.byteLength !== backup.sizeBytes) {
        throw new Error('The downloaded backup size does not match its verified manifest.');
      }
      const checksum = [...new Uint8Array(await crypto.subtle.digest('SHA-256', plaintext))]
        .map((byte) => byte.toString(16).padStart(2, '0')).join('');
      if (!backup.sha256 || checksum !== backup.sha256) throw new Error('Backup verification failed. No download was created.');
      const encrypted = await encryptPortableBackup(plaintext, portablePassphrase);
      const url = URL.createObjectURL(new Blob([encrypted], { type: PORTABLE_BACKUP_MIME_TYPE }));
      const link = document.createElement('a');
      link.href = url;
      link.download = getPortableBackupFilename(backup.filename);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      toast({ message: 'Encrypted backup ready. Store it somewhere off this device.' });
    } catch (error) {
      toast({
        message: error instanceof Error ? error.message : 'Failed to encrypt backup',
        variant: 'error',
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function restoreManagedBackup(filename: string) {
    if (confirmation !== 'RESTORE') return;
    setBusyAction(`restore:${filename}`);
    try {
      const response = await fetch('/api/settings/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, confirmation }),
      });
      if (!response.ok) {
        throw new Error(await getResponseErrorMessage(response, 'Failed to restore backup'));
      }
      const next = await response.json() as Pick<BackupResponse, 'backups'>;
      setData((previous) => previous ? { ...previous, backups: next.backups } : previous);
      setConfirmation('');
      setConfirmationTarget(null);
      toast({ message: cloud
        ? 'Database restored. Email alerts are off until you re-enable them on Reminders.'
        : 'Database restored. The previous state was saved as a recovery point.' });
    } catch (error) {
      setConfirmationTarget(null);
      toast({
        message: error instanceof Error ? error.message : 'Failed to restore backup',
        variant: 'error',
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function restoreUploadedBackup() {
    if (!restoreFile || confirmation !== 'RESTORE') return;
    setBusyAction('upload');
    try {
      const maximumBytes = (data?.maxRestoreMegabytes || 256) * 1024 * 1024;
      const encrypted = restoreFile.name.toLowerCase().endsWith('.bonds');
      let uploadBody: Blob = restoreFile;
      let uploadFilename = restoreFile.name;

      if (encrypted) {
        if (restoreFile.size > maximumBytes + PORTABLE_BACKUP_OVERHEAD_BYTES) {
          throw new Error('The encrypted backup exceeds the configured restore size limit.');
        }
        const decrypted = await decryptPortableBackup(
          await restoreFile.arrayBuffer(),
          restorePassphrase
        );
        if (decrypted.byteLength > maximumBytes) {
          throw new Error('The decrypted backup exceeds the configured restore size limit.');
        }
        uploadBody = new Blob([decrypted], { type: cloud ? 'application/json' : 'application/vnd.sqlite3' });
        uploadFilename = getPortableBackupFilename(restoreFile.name.replace(/\.bonds$/i, '.db'))
          .replace(/\.bonds$/i, '.db');
      }

      const response = await fetch('/api/settings/restore', {
        method: 'POST',
        headers: {
          'Content-Type': cloud ? 'application/json' : 'application/vnd.sqlite3',
          'X-Bonds-Restore-Confirmation': confirmation,
          'X-Bonds-Restore-Filename': uploadFilename,
        },
        body: uploadBody,
      });
      if (!response.ok) {
        throw new Error(await getResponseErrorMessage(response, 'Failed to restore database file'));
      }
      const next = await response.json() as Pick<BackupResponse, 'backups'>;
      setData((previous) => previous ? { ...previous, backups: next.backups } : previous);
      setRestoreFile(null);
      setRestorePassphrase('');
      setConfirmation('');
      setConfirmationTarget(null);
      toast({ message: cloud
        ? 'Database file restored. Email alerts are off until you re-enable them on Reminders.'
        : 'Database file restored. The previous state was preserved.' });
    } catch (error) {
      setConfirmationTarget(null);
      toast({
        message: error instanceof Error ? error.message : 'Failed to restore database file',
        variant: 'error',
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function eraseAllData() {
    if (erasureConfirmation !== WORKSPACE_ERASURE_CONFIRMATION) return;

    setBusyAction('erase');
    try {
      let complete = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        const response = await fetch('/api/settings/erase', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmation: erasureConfirmation }),
        });
        if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Failed to erase Everclose CRM data'));
        const result = await response.json() as { success?: boolean; pending?: boolean };
        if (response.status === 202 && result.pending) {
          setData((previous) => previous ? { ...previous, lifecycle: 'erasing' } : previous);
          continue;
        }
        if (result.success !== true) throw new Error('Erasure completion could not be verified. Refresh and resume.');
        complete = true;
        break;
      }
      if (!complete) {
        setBusyAction(null);
        setConfirmationTarget(null);
        toast({ message: 'Erasure is still in progress. Continue below to remove the remaining files.' });
        return;
      }

      for (const key of [
        'contacts-view-mode',
        REMINDER_NOTIFICATION_PREFERENCE_KEY,
        REMINDER_NOTIFICATION_LEDGER_KEY,
        BIRTHDAY_NOTIFICATION_LEDGER_KEY,
      ]) {
        try {
          window.localStorage.removeItem(key);
        } catch {
          // Server-side erasure still succeeds when browser storage is unavailable.
        }
      }
      window.location.assign('/');
    } catch (error) {
      toast({
        message: error instanceof Error ? error.message : 'Failed to erase Everclose CRM data',
        variant: 'error',
      });
      setBusyAction(null);
      setReloadToken((value) => value + 1);
    }
  }

  if (loading && !loadError) return <SkeletonSettings />;

  if (loadError || !data) {
    return (
      <div className="space-y-6">
        <SettingsHeading />
        <LoadError
          title="We couldn't verify your recovery state"
          message={`${loadError || 'The server returned an incomplete backup response'}. Backup and restore controls are hidden until verification succeeds.`}
          retrying={loading}
          onRetry={() => setReloadToken((value) => value + 1)}
        />
      </div>
    );
  }

  const backups = data.backups;
  const targetBackup = confirmationTarget && 'backup' in confirmationTarget
    ? confirmationTarget.backup
    : null;
  const confirmationTitle = confirmationTarget?.kind === 'delete-backup'
    ? 'Delete this backup?'
    : confirmationTarget?.kind === 'restore-managed'
      ? 'Restore this backup?'
      : confirmationTarget?.kind === 'restore-upload'
        ? 'Restore the selected file?'
        : 'Permanently erase Everclose CRM?';
  const confirmationDescription = confirmationTarget?.kind === 'delete-backup' && targetBackup
    ? `Remove the ${formatBackupReason(targetBackup.reason).toLowerCase()} from ${new Date(targetBackup.createdAt).toLocaleString()}, including its integrity manifest.`
    : confirmationTarget?.kind === 'restore-managed' && targetBackup
      ? `Replace the active CRM with the verified snapshot from ${new Date(targetBackup.createdAt).toLocaleString()} containing ${targetBackup.rowCounts.contacts || 0} contacts.`
      : confirmationTarget?.kind === 'restore-upload' && restoreFile
        ? `Replace the active CRM with ${restoreFile.name} (${formatBytes(restoreFile.size)}). The file will be decrypted and validated before use.`
        : 'Remove all contacts, relationship history, reminders, plans, groups, settings, and every managed backup from this installation.';
  const confirmationIsRecoveryBacked = confirmationTarget?.kind === 'restore-managed'
    || confirmationTarget?.kind === 'restore-upload';
  const confirmationSafetyNote = confirmationIsRecoveryBacked
    ? `The current database will be saved as a verified recovery point before any data is replaced.${cloud ? ' Email alerts will turn off and must be re-enabled after restore.' : ''}`
    : confirmationTarget?.kind === 'delete-backup'
      ? 'This removes only the selected recovery file, but deleting that file cannot be undone.'
      : 'This action has no in-app recovery point and cannot be undone.';
  const confirmationLabel = confirmationTarget?.kind === 'delete-backup'
    ? 'Delete backup'
    : confirmationTarget?.kind === 'restore-managed' || confirmationTarget?.kind === 'restore-upload'
      ? 'Restore database'
      : 'Erase all Everclose CRM data';
  const confirmationPendingLabel = confirmationTarget?.kind === 'restore-upload'
    ? 'Decrypting and validating...'
    : confirmationTarget?.kind === 'restore-managed'
      ? 'Creating recovery point...'
      : confirmationTarget?.kind === 'erase'
        ? 'Erasing...'
        : 'Deleting...';
  const latestBackup = backups[0];
  const automaticBackup = data.automaticBackup;
  const automaticCurrent = automaticBackup?.state === 'current';
  const automaticDisabled = automaticBackup?.state === 'disabled';
  const isConfirmed = confirmation === 'RESTORE';
  const portablePassphraseReady = portablePassphrase.trim().length
    >= PORTABLE_BACKUP_MINIMUM_PASSPHRASE_LENGTH
    && portablePassphrase === portablePassphraseConfirmation;
  const restoringEncryptedBackup = restoreFile?.name.toLowerCase().endsWith('.bonds') || false;

  return (
    <div className="space-y-6">
      <SettingsHeading cloud={cloud} />

      {cloud && <Card><CardContent className="flex flex-wrap items-center justify-between gap-4 pt-6">
        <div><p className="font-semibold">Connected phones</p><p className="mt-1 text-sm text-muted-foreground">Review your native app sessions and revoke a lost phone.</p></div>
        <Link href="/settings/devices" className={buttonVariants({ variant: 'outline' })}>Manage phones</Link>
      </CardContent></Card>}

      {erasing && (
        <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          Erasure is unfinished. New data and recovery operations are paused. Use the erasure confirmation below to resume safely.
        </div>
      )}
      {restoring && (
        <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          {data.largeRecoveryEnabled
            ? 'Workspace recovery is in progress. Your data is temporarily unavailable. Continue or roll back from Advanced recovery below.'
            : 'Workspace recovery is in progress. Your data is temporarily unavailable. Contact support before attempting another recovery operation.'}
        </div>
      )}

      {cloud && data.largeRecoveryEnabled && (
        <Card className="border border-sky-200 bg-sky-50/50 shadow-sm">
          <CardContent className="flex flex-col gap-4 pt-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="font-semibold text-sky-950">Advanced recovery</p>
              <p className="mt-1 text-sm text-sky-900/80">
                Capture and verify larger cloud snapshots, or safely resume an interrupted restore.
              </p>
            </div>
            <Link href="/settings/advanced-recovery" className={buttonVariants({ variant: 'outline', className: 'border-sky-300 bg-white text-sky-950 hover:bg-sky-100' })}>
              {restoring ? 'Continue recovery' : 'Open advanced recovery'}
            </Link>
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={confirmationTarget !== null}
        title={confirmationTitle}
        description={confirmationDescription}
        safetyNote={confirmationSafetyNote}
        safetyTone={confirmationIsRecoveryBacked ? 'recovery' : 'irreversible'}
        confirmLabel={confirmationLabel}
        pendingLabel={confirmationPendingLabel}
        pending={busyAction !== null}
        onCancel={() => setConfirmationTarget(null)}
        onConfirm={() => {
          if (confirmationTarget?.kind === 'delete-backup') {
            void deleteBackup(confirmationTarget.backup.filename);
          } else if (confirmationTarget?.kind === 'restore-managed') {
            void restoreManagedBackup(confirmationTarget.backup.filename);
          } else if (confirmationTarget?.kind === 'restore-upload') {
            void restoreUploadedBackup();
          } else if (confirmationTarget?.kind === 'erase') {
            void eraseAllData();
          }
        }}
      />

      <div className="grid gap-4 md:grid-cols-3 animate-fade-in-up">
        <Card className="min-w-0 border-0 shadow-sm md:col-span-2">
          <CardContent className="flex flex-col gap-5 pt-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className={`rounded-xl p-2.5 ${automaticCurrent ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                <ShieldCheck className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold">
                    {!automaticBackup
                      ? 'Checking automatic protection'
                      : automaticCurrent
                        ? 'Automatic protection is active'
                        : automaticDisabled
                          ? 'Automatic backups are off'
                          : 'Automatic protection needs attention'}
                  </p>
                  {automaticBackup && (
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      automaticCurrent
                        ? 'bg-emerald-50 text-emerald-700'
                        : automaticDisabled
                          ? 'bg-muted text-muted-foreground'
                          : 'bg-amber-100 text-amber-800'
                    }`}>
                      {automaticBackup.state}
                    </span>
                  )}
                </div>
                <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                  {!automaticBackup
                    ? 'Checking the latest verified recovery status.'
                    : automaticCurrent
                    ? `The latest verified automatic snapshot was ${automaticBackup.latestBackupAt ? new Date(automaticBackup.latestBackupAt).toLocaleString() : 'recently'}. The next is due ${automaticBackup.nextBackupAt ? new Date(automaticBackup.nextBackupAt).toLocaleString() : `after ${formatBackupInterval(automaticBackup.intervalHours)}`}.`
                    : automaticDisabled
                      ? cloud ? 'Manual backups and recovery points before contact deletion and restoration are available. Scheduled cloud backups are not enabled yet.' : <>Manual and pre-change recovery points remain available. Set <span className="break-all">CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS</span> to enable unattended protection.</>
                      : cloud && automaticBackup.issue === 'too_large'
                        ? 'This workspace exceeds the 16 MB automatic recovery limit. New scheduled snapshots cannot be created yet; older recovery points may still exist. Larger recovery jobs are required.'
                        : cloud && automaticBackup.issue === 'backup_missing'
                          ? 'The latest scheduled snapshot is missing from private storage. Automatic protection is not verified; create a manual backup now and investigate storage health.'
                        : cloud && automaticBackup.state === 'due'
                          ? automaticBackup.latestBackupAt
                            ? `Another scheduled cloud snapshot is due. The last verified one was ${new Date(automaticBackup.latestBackupAt).toLocaleString()}; you can back up now.`
                            : 'The first scheduled cloud snapshot is due. No automatic recovery point has been verified yet; you can back up now.'
                          : cloud
                            ? `The last scheduled cloud snapshot failed. ${automaticBackup.nextBackupAt ? `The next attempt is ${new Date(automaticBackup.nextBackupAt).toLocaleString()}. ` : ''}You can back up now or try again after service recovers.`
                            : 'Create a manual backup now and check that the configured backup directory is writable.'}
                </p>
              </div>
            </div>
            <Button onClick={createBackup} disabled={recoveryUnavailable} className="sm:flex-shrink-0">
              {busyAction === 'create' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <DatabaseBackup className="h-4 w-4" />}
              Back up now
            </Button>
          </CardContent>
        </Card>

        <Card className="min-w-0 border-0 shadow-sm">
          <CardContent className="pt-6">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Latest protection</p>
            <p className="mt-2 text-lg font-semibold">
              {latestBackup ? new Date(latestBackup.createdAt).toLocaleDateString() : 'No backups yet'}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {latestBackup
                ? `${latestBackup.rowCounts.contacts || 0} contacts · ${formatBytes(latestBackup.sizeBytes)}`
                : 'Create the first recovery point.'}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card className="border border-emerald-200/70 bg-emerald-50/30 shadow-sm animate-fade-in-up">
        <CardHeader className="pb-3">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-emerald-100 p-2.5 text-emerald-700">
              <LockKeyhole className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-lg">Off-device safety</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                Encrypt a verified snapshot in this browser, then keep the .bonds file somewhere separate from this device.
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="portable-passphrase" className="text-sm font-medium">Backup passphrase</label>
            <Input
              id="portable-passphrase"
              type="password"
              value={portablePassphrase}
              onChange={(event) => setPortablePassphrase(event.target.value)}
              autoComplete="new-password"
              placeholder="Use a unique phrase you can remember"
              disabled={busyAction !== null}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="portable-passphrase-confirmation" className="text-sm font-medium">Confirm passphrase</label>
            <Input
              id="portable-passphrase-confirmation"
              type="password"
              value={portablePassphraseConfirmation}
              onChange={(event) => setPortablePassphraseConfirmation(event.target.value)}
              autoComplete="new-password"
              placeholder="Enter the same phrase again"
              disabled={busyAction !== null}
            />
          </div>
          <div className="flex flex-col gap-3 rounded-xl border border-emerald-200/60 bg-white/70 p-4 lg:col-span-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="max-w-2xl text-xs leading-relaxed text-emerald-900">
              The passphrase never leaves this browser and cannot be recovered by Everclose CRM. Use at least {PORTABLE_BACKUP_MINIMUM_PASSPHRASE_LENGTH} characters and store it separately from the encrypted file.
            </p>
            <Button
              variant="outline"
              disabled={!latestBackup || !portablePassphraseReady || recoveryUnavailable}
              onClick={() => latestBackup && downloadEncryptedBackup(latestBackup)}
              className="flex-shrink-0 border-emerald-300 bg-white hover:bg-emerald-50"
            >
              {latestBackup && busyAction === `download:${latestBackup.filename}`
                ? <RefreshCw className="h-4 w-4 animate-spin" />
                : <Download className="h-4 w-4" />}
              Download latest encrypted
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border-0 shadow-sm animate-fade-in-up">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-lg">Backup history</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                Up to {data?.retentionCount || 20} backups are retained, preserving the newest checkpoint of each kind.
                {cloud && ' Recovery points protecting an operation are retained in addition to this limit.'}
              </p>
            </div>
            <span className="w-fit rounded-full border border-border/70 bg-muted/40 px-2.5 py-1 text-xs font-medium text-muted-foreground">
              {backups.length} saved
            </span>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((item) => <div key={item} className="skeleton h-20 rounded-xl" />)}
            </div>
          ) : backups.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-8 text-center">
              <DatabaseBackup className="mx-auto h-6 w-6 text-muted-foreground" />
              <p className="mt-3 text-sm font-medium">No database backups yet</p>
              <p className="mt-1 text-xs text-muted-foreground">Your first backup will appear here.</p>
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {backups.map((backup) => (
                <div key={backup.filename} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 lg:flex-row lg:items-center">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium">{new Date(backup.createdAt).toLocaleString()}</p>
                      <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-secondary-foreground">
                        {formatBackupReason(backup.reason)}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {backup.rowCounts.contacts || 0} contacts · {formatBytes(backup.sizeBytes)} · SHA-256 {backup.sha256.slice(0, 12)}…
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!portablePassphraseReady || recoveryUnavailable}
                      onClick={() => downloadEncryptedBackup(backup)}
                    >
                      {busyAction === `download:${backup.filename}`
                        ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                        : <Download className="h-3.5 w-3.5" />}
                      Encrypted copy
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!isConfirmed || recoveryUnavailable}
                      onClick={() => setConfirmationTarget({ kind: 'restore-managed', backup })}
                    >
                      {busyAction === `restore:${backup.filename}`
                        ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                        : <ArchiveRestore className="h-3.5 w-3.5" />}
                      Restore
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      disabled={recoveryUnavailable || backup.protected}
                      onClick={() => setConfirmationTarget({ kind: 'delete-backup', backup })}
                      aria-label="Delete backup"
                    >
                      {busyAction === `delete:${backup.filename}`
                        ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                        : <Trash2 className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border border-amber-200/70 bg-amber-50/30 shadow-sm animate-fade-in-up">
        <CardHeader className="pb-3">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-amber-100 p-2.5 text-amber-700">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-lg">Restore database</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                Restoring replaces current CRM data. Everclose CRM validates the file and creates a recovery point before making changes.
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-5 lg:grid-cols-2">
          <div className="space-y-3 rounded-xl border border-amber-200/60 bg-white/70 p-4">
            <div className="flex items-center gap-2">
              <Upload className="h-4 w-4 text-amber-700" />
              <p className="text-sm font-semibold">Restore from a file</p>
            </div>
            <label htmlFor="restore-file" className="sr-only">Backup file to restore</label>
            <Input
              id="restore-file"
              type="file"
              accept={cloud ? '.bonds,.json,application/json,application/vnd.bonds.backup' : '.bonds,.db,application/vnd.bonds.backup,application/vnd.sqlite3,application/x-sqlite3'}
              disabled={busyAction !== null}
              onChange={(event) => {
                setRestoreFile(event.target.files?.[0] || null);
                setRestorePassphrase('');
              }}
            />
            {restoringEncryptedBackup && (
              <div className="space-y-1.5">
                <label htmlFor="restore-passphrase" className="text-sm font-medium">Encrypted backup passphrase</label>
                <Input
                  id="restore-passphrase"
                  type="password"
                  value={restorePassphrase}
                  onChange={(event) => setRestorePassphrase(event.target.value)}
                  autoComplete="current-password"
                  placeholder="Passphrase used for this .bonds file"
                  disabled={busyAction !== null}
                />
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Maximum decrypted size: {data?.maxRestoreMegabytes || 256} MB. Encrypted .bonds files are decrypted only in this browser; raw compatible database files remain supported.
              {cloud && (data.largeRecoveryEnabled
                ? ' Cloud mode accepts JSON backups from this same workspace; use Advanced recovery for larger private cloud snapshots.'
                : ' Cloud mode accepts JSON backups from this same workspace, not local SQLite databases. Larger recovery jobs are not yet supported.')}
            </p>
            <Button
              variant="destructive"
              className="w-full"
              disabled={
                !restoreFile
                || !isConfirmed
                || recoveryUnavailable
                || (restoringEncryptedBackup
                  && restorePassphrase.trim().length < PORTABLE_BACKUP_MINIMUM_PASSPHRASE_LENGTH)
              }
              onClick={() => setConfirmationTarget({ kind: 'restore-upload' })}
            >
              {busyAction === 'upload' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <ArchiveRestore className="h-4 w-4" />}
              Restore selected file
            </Button>
          </div>

          <div className="space-y-3 rounded-xl border border-amber-200/60 bg-white/70 p-4">
            <p className="text-sm font-semibold">Safety confirmation</p>
            <p className="text-xs text-muted-foreground">
              Type <span className="font-mono font-semibold text-foreground">RESTORE</span> to enable restore actions.
            </p>
            <label htmlFor="restore-confirmation" className="sr-only">Restore safety confirmation</label>
            <Input
              id="restore-confirmation"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              placeholder="Type RESTORE"
              autoComplete="off"
              spellCheck={false}
              disabled={busyAction !== null}
            />
            <div className="rounded-lg bg-emerald-50 p-3 text-xs leading-relaxed text-emerald-800">
              Your current database is always backed up first. If the restored version is not what you expected, that recovery point remains available above.
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border border-red-200/80 bg-red-50/30 shadow-sm animate-fade-in-up">
        <CardHeader className="pb-3">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-red-100 p-2.5 text-red-700">
              <Trash2 className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-lg">Permanently erase Everclose CRM</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                Remove all contacts, relationship history, reminders, plans, groups, workspace settings, and backups managed by this Everclose CRM installation.
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.65fr)]">
          <div className="space-y-3 rounded-xl border border-red-200/70 bg-white/75 p-4 text-sm">
            <p className="font-semibold text-red-900">This action has no in-app recovery point.</p>
            <p className="leading-relaxed text-muted-foreground">
              {cloud ? 'This removes CRM records, workspace preferences, retry receipts, and files managed by this workspace. Your Google account, sign-in identity, and billing plan are not deleted. If interrupted, erasure can be resumed.' : 'Everclose CRM deletes its database records, compacts deleted SQLite pages, truncates its recovery log, and removes every recognized managed backup artifact. Your sign-in password and deployment configuration remain unchanged.'}
            </p>
            <p className="leading-relaxed text-muted-foreground">
              {cloud ? 'Downloaded copies and Cloudflare operator-level recovery copies are outside this in-app erasure and follow their separate retention policies.' : <>Files you downloaded, host-level snapshots, and storage-device forensic copies are outside Everclose CRM&apos;s control and must be removed separately.</>}
            </p>
          </div>

          <div className="space-y-3 rounded-xl border border-red-200/70 bg-white/75 p-4">
            <label htmlFor="erasure-confirmation" className="text-sm font-semibold text-red-900">
              Type <span className="font-mono">{WORKSPACE_ERASURE_CONFIRMATION}</span> to continue
            </label>
            <Input
              id="erasure-confirmation"
              value={erasureConfirmation}
              onChange={(event) => setErasureConfirmation(event.target.value)}
              placeholder={WORKSPACE_ERASURE_CONFIRMATION}
              autoComplete="off"
              spellCheck={false}
              disabled={busyAction !== null || restoring}
              aria-describedby="erasure-warning"
            />
            <p id="erasure-warning" className="text-xs leading-relaxed text-red-800">
              Do not continue until you have exported anything you want to keep.
            </p>
            <Button
              variant="destructive"
              className="min-h-11 w-full"
              disabled={
                erasureConfirmation !== WORKSPACE_ERASURE_CONFIRMATION
                || busyAction !== null
                || restoring
              }
              onClick={() => setConfirmationTarget({ kind: 'erase' })}
            >
              {busyAction === 'erase'
                ? <RefreshCw className="h-4 w-4 animate-spin" />
                : <Trash2 className="h-4 w-4" />}
              Erase all Everclose CRM data
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
