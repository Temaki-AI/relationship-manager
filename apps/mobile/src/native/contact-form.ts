import type { SQLiteDatabase } from 'expo-sqlite';
import { useEffect, useMemo, useRef, useState } from 'react';
import { clearContactDraft, contactDraftSession, readContactDraft, type ContactFormDraft, type ContactFormFields } from '@/data/contact-drafts';

export function useContactForm(db: SQLiteDatabase, key: string, initial: () => Promise<ContactFormDraft>) {
  const session = useMemo(() => contactDraftSession(db, key), [db, key]);
  const [draft, setDraft] = useState<ContactFormDraft | null>(null);
  const [error, setError] = useState(''), [resumed, setResumed] = useState(false), [saving, setSaving] = useState(false);
  const [retry, setRetry] = useState(0);
  const latest = useRef<ContactFormDraft | null>(null), writeRevision = useRef(0), busy = useRef(false);
  useEffect(() => {
    let active = true;
    latest.current = null;
    void (async () => {
      const saved = await readContactDraft(db, key), value = saved ?? await initial();
      if (active) { latest.current = value; setDraft(value); setResumed(!!saved); setError(''); }
    })().catch(() => { if (active) setError('Unable to open your form. Any saved draft is still on this phone. Try again.'); });
    return () => { active = false; };
  }, [db, key, initial, retry]);

  function change(fields: Partial<ContactFormFields>) {
    if (!latest.current || busy.current) return;
    const next = { ...latest.current, fields: { ...latest.current.fields, ...fields } };
    latest.current = next; setDraft(next);
    const revision = ++writeRevision.current;
    void session.write(next).then(() => { if (writeRevision.current === revision) setError(''); }, () => {
      if (writeRevision.current === revision) setError('Your latest changes could not be kept on this phone. Keep this form open and try again.');
    });
  }

  async function save<T>(action: (draft: ContactFormDraft) => Promise<T>): Promise<T | null> {
    if (!latest.current || busy.current) return null;
    busy.current = true;
    setSaving(true); setError('');
    try { return await session.finish(() => action(latest.current!)); }
    catch (error) { setError(error instanceof Error ? error.message : 'Unable to save. Your form is still here.'); return null; }
    finally { busy.current = false; setSaving(false); }
  }
  async function discard(): Promise<boolean> {
    if (busy.current) return false;
    busy.current = true;
    setSaving(true);
    try { await session.finish(() => clearContactDraft(db, key), true); return true; }
    catch { setError('Unable to discard this form. Try again.'); return false; }
    finally { busy.current = false; setSaving(false); }
  }
  async function close(): Promise<boolean> {
    if (busy.current) return false;
    busy.current = true; setSaving(true);
    try { await session.finish(async () => {}); return true; }
    catch { setError('Your latest changes could not be kept. Keep this form open and retry, or explicitly discard it.'); return false; }
    finally { busy.current = false; setSaving(false); }
  }
  return { draft, error, resumed, saving, change, save, discard, close,
    retry: () => { setDraft(null); setError(''); setRetry((value) => value + 1); } };
}
