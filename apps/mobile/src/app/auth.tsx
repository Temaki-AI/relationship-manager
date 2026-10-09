import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { useNativeAccount } from '@/native/account';
import { ActionButton } from '@/components/design-system';
import { DEVICE_CALLBACK_URL } from '../../../../packages/domain/src/devices';

export default function NativeCallbackScreen() {
  const params = useLocalSearchParams<{ code?: string; state?: string }>();
  const { account, pending, finishCallback } = useNativeAccount();
  const router = useRouter();
  const [error, setError] = useState('');
  const handled = useRef(false);
  const invalid = typeof params.code !== 'string' || typeof params.state !== 'string';
  useEffect(() => {
    if (account && !pending) { router.replace('/(tabs)/people'); return; }
    if (handled.current) return;
    if (typeof params.code !== 'string' || typeof params.state !== 'string') return;
    handled.current = true;
    const callback = new URL(DEVICE_CALLBACK_URL);
    callback.searchParams.set('code', params.code); callback.searchParams.set('state', params.state);
    // AccountDatabase remounts the navigator when the workspace changes. Navigate
    // from the ready account effect above, not from the old navigator's promise.
    void finishCallback(callback.href).catch((error) => {
      setError(error instanceof Error ? error.message : 'Unable to finish sign-in. Return to Account & sync.');
    });
  }, [account, pending, finishCallback, params.code, params.state, router, invalid]);
  const message = invalid ? 'Start sign-in from Account & sync.' : error;
  return <View style={{ padding: 24, gap: 20 }}><Text accessibilityRole={message ? 'alert' : undefined}>{message || 'Finishing sign-in…'}</Text>
    {!!message && <ActionButton label="Account & sync" variant="secondary" onPress={() => router.replace('/account')} />}
  </View>;
}
