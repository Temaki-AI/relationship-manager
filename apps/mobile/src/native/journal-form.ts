import type { SQLiteDatabase } from 'expo-sqlite';
import { useEffect, useMemo, useRef, useState } from 'react';
import { clearJournalDraft, journalDraftSession, readJournalDraft, type JournalDraft } from '@/data/journal-drafts';

export function useJournalForm<T extends JournalDraft>(db: SQLiteDatabase, key: string, initial: () => Promise<T>) {
  const session = useMemo(() => journalDraftSession(db, key), [db, key]);
  const [draft, setDraft] = useState<T | null>(null), [resumed, setResumed] = useState(false);
  const [error, setError] = useState(''), [saving, setSaving] = useState(false), [retry, setRetry] = useState(0);
  const latest = useRef<T | null>(null), busy = useRef(false), writeRevision = useRef(0);
  useEffect(() => {
    let active = true; latest.current = null;
    void (async () => {
      const saved = await readJournalDraft(db, key), value = saved as T | null ?? await initial();
      if (active) { latest.current = value; setDraft(value); setResumed(!!saved); setError(''); }
    })().catch((error) => { if (active) setError(error instanceof Error ? error.message : 'Unable to open your form. Any saved draft is still on this phone.'); });
    return () => { active = false; };
  }, [db, key, initial, retry]);
  function change(update: (draft: T) => T) {
    if (!latest.current || busy.current) return;
    const next = update(latest.current); latest.current = next; setDraft(next);
    const revision = ++writeRevision.current;
    void session.write(next).then(() => { if (writeRevision.current === revision) setError(''); }, () => {
      if (writeRevision.current === revision) setError('Your latest changes could not be kept on this phone. Keep the form open and retry.');
    });
  }
  async function finish<R>(action: () => Promise<R>, discard = false): Promise<R | null> {
    if (busy.current) return null;
    busy.current = true; setSaving(true); setError('');
    try { return await session.finish(action, discard); }
    catch (error) { setError(error instanceof Error ? error.message : 'Unable to finish. Your form is still here.'); return null; }
    finally { busy.current = false; setSaving(false); }
  }
  return { draft, error, saving, resumed, change,
    save: <R,>(action: (draft: T) => Promise<R>) => latest.current ? finish(() => action(latest.current!)) : Promise.resolve(null),
    close: () => finish(async () => true), discard: () => finish(async () => { await clearJournalDraft(db, key); return true; }, true),
    retry: () => { setDraft(null); setError(''); setRetry((value) => value + 1); },
  };
}
