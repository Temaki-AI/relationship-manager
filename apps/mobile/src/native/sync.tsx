import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import { useSQLiteContext } from 'expo-sqlite';
import { NativeSyncError, syncWorkspace, syncSummary, type SyncSummary } from '@/data/cloud-sync';
import { subscribeSyncChanges } from '@/data/sync-signals';
import { useNativeAccount } from './account';
import { runDeviceContactReads } from './device-contact-sync';
import { appleCalendarAdapter } from './apple-calendar';
import { refreshAppleCalendarReads } from '@/data/apple-calendar';
import { clearGmailContext, refreshGmailManifest } from '@/data/gmail-context';
import { accountScope } from '../../../../packages/domain/src/devices';
import { registerPrivateAccountCache } from './private-account-cache';
import { syncPromptSnoozes } from '@/data/today-snoozes';
import { syncCalendarReservations } from '@/data/calendar-reservations';
import { syncCalendarPublicationReviews } from '@/data/calendar-publication-reviews';

type NativeSyncContextValue = { syncing: boolean; error: string | null; gmailError: string | null; promptError: string | null; calendarError: string | null; summary: SyncSummary; revision: number; run: () => Promise<void> };
const NativeSyncContext = createContext<NativeSyncContextValue | null>(null);

export function NativeSyncProvider({ children }: { children: ReactNode }) {
  const db = useSQLiteContext(), { account } = useNativeAccount();
  const [syncing, setSyncing] = useState(false), [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<SyncSummary>({ pending: 0, conflicts: 0, phoneOnly: 0, lastSuccess: null });
  const [revision, setRevision] = useState(0);
  const [gmailError, setGmailError] = useState<string | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const generation = useRef(0), running = useRef(false), needsSignIn = useRef(false);
  const run = useCallback(async () => {
    if (running.current || Platform.OS === 'web') return;
    const current = generation.current;
    running.current = true; setSyncing(true);
    try {
      if (account) await syncWorkspace(db, account, { isCurrent: () => generation.current === current });
      const sourceReads = await runDeviceContactReads(db, { isCurrent: () => generation.current === current });
      const calendarReads = account && Platform.OS === 'ios' ? await refreshAppleCalendarReads(db, account, appleCalendarAdapter, () => generation.current === current) : { changed: 0 };
      if (account && (sourceReads.changed || calendarReads.changed) && generation.current === current) await syncWorkspace(db, account, { isCurrent: () => generation.current === current });
      if (account && generation.current === current) {
        let calendarFailure: string | null = null;
        try { await syncCalendarPublicationReviews(db, account, { isCurrent: () => generation.current === current }); }
        catch (error) { calendarFailure = error instanceof Error ? error.message : 'Unable to confirm Calendar verification.'; }
        try { await syncCalendarReservations(db, account, { isCurrent: () => generation.current === current }); }
        catch (error) { calendarFailure ??= error instanceof Error ? error.message : 'Unable to confirm Calendar publication.'; }
        if (generation.current === current) setCalendarError(calendarFailure);
        try { await syncPromptSnoozes(db, account, { isCurrent: () => generation.current === current }); if (generation.current === current) setPromptError(null); }
        catch (error) { if (generation.current === current) setPromptError(error instanceof Error ? error.message : 'Unable to sync prompt choices.'); }
        try { await refreshGmailManifest(db, account, { isCurrent: () => generation.current === current }); if (generation.current === current) setGmailError(null); }
        catch (error) { if (generation.current === current) setGmailError(error instanceof Error ? error.message : 'Unable to refresh email context.'); }
      }
      if (generation.current === current) { setError(null); needsSignIn.current = false; }
    } catch (error) {
      if (generation.current !== current) return;
      needsSignIn.current = error instanceof NativeSyncError && error.status === 401;
      if (error instanceof NativeSyncError && [401, 403, 423].includes(error.status)) {
        try { await clearGmailContext(db); } catch { /* Retain the sync failure; the current view also requires a valid account. */ }
      }
      setError(error instanceof Error ? error.message : 'Unable to sync. Offline data is still here.');
    } finally {
      if (generation.current === current) {
        try {
          const next = await syncSummary(db);
          if (generation.current === current) setSummary(next);
        } catch { /* A closing database belongs to the previous account. */ }
        if (generation.current === current) { setSyncing(false); setRevision((value) => value + 1); }
      }
      running.current = false;
    }
  }, [db, account]);
  useEffect(() => account ? registerPrivateAccountCache(accountScope(account), () => clearGmailContext(db, true)) : undefined, [db, account]);
  useEffect(() => {
    const effectGeneration = ++generation.current; needsSignIn.current = false;
    let active = true;
    const refresh = () => {
      if (active && AppState.currentState === 'active' && !needsSignIn.current) void run();
    };
    // The asynchronous kickoff also runs after SQLite initialization and rendering.
    void Promise.resolve().then(refresh);
    const interval = setInterval(refresh, 30_000);
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') refresh(); });
    const unsubscribe = subscribeSyncChanges(db, () => { void Promise.resolve().then(refresh); });
    return () => { active = false; generation.current = effectGeneration + 1; clearInterval(interval); subscription.remove(); unsubscribe(); };
  }, [db, run]);
  return <NativeSyncContext.Provider value={{ syncing, error, gmailError, promptError, calendarError, summary, revision, run }}>{children}</NativeSyncContext.Provider>;
}
export function useNativeSync() {
  const value = useContext(NativeSyncContext);
  if (!value) throw new Error('Native sync provider is unavailable.');
  return value;
}
