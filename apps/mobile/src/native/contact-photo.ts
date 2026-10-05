import { useEffect, useState } from 'react';
import { useSQLiteContext } from 'expo-sqlite';
import { cachedContactPhoto, loadContactPhoto } from '@/data/contact-photos';
import { useNativeAccount } from './account';
import { useNativeSync } from './sync';
import { accountScope } from '../../../../packages/domain/src/devices';

export function useContactPhoto(contactId: string, download = false, focused = true) {
  const db = useSQLiteContext(), { account } = useNativeAccount(), { revision } = useNativeSync();
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ key: string; uri: string | null; error: string }>({ key: '', uri: null, error: '' });
  const key = `${accountScope(account)}:${contactId}:${revision}:${retry}`;
  useEffect(() => {
    if (!focused || !account) return;
    let active = true;
    void (async () => {
      const cached = await cachedContactPhoto(db, contactId, accountScope(account));
      if (active) setState({ key, uri: cached, error: '' });
      if (active && download) {
        const uri = await loadContactPhoto(db, account, contactId, { isCurrent: () => active });
        if (active) setState({ key, uri, error: '' });
      }
    })().catch((error) => {
      if (active) setState((previous) => ({ key, uri: previous.key === key ? previous.uri : null,
        error: error instanceof Error ? error.message : 'Unable to download this photo.' }));
    });
    return () => { active = false; };
  }, [account, db, contactId, download, focused, key]);
  return { uri: state.key === key && account ? state.uri : null, error: state.key === key ? state.error : '', retry: () => setRetry((value) => value + 1) };
}
