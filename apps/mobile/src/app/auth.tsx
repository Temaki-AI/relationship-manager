import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { useNativeAccount } from '@/native/account';
import { DEVICE_CALLBACK_URL } from '../../../../packages/domain/src/devices';

export default function NativeCallbackScreen() {
  const params = useLocalSearchParams<{ code?: string; state?: string }>();
  const { account, pending, finishCallback } = useNativeAccount();
  const router = useRouter();
  const [error, setError] = useState('');
  const handled = useRef(false);
  const invalid = typeof params.code !== 'string' || typeof params.state !== 'string';
  useEffect(() => {
    if (account && !pending) { router.replace('/account'); return; }
    if (handled.current) return;
    if (typeof params.code !== 'string' || typeof params.state !== 'string') return;
    handled.current = true;
    const callback = new URL(DEVICE_CALLBACK_URL);
    callback.searchParams.set('code', params.code); callback.searchParams.set('state', params.state);
    void finishCallback(callback.href).then(() => router.replace('/account')).catch((error) => {
      setError(error instanceof Error ? error.message : 'Unable to finish sign-in. Return to Account & sync.');
    });
  }, [account, pending, finishCallback, params.code, params.state, router, invalid]);
  const message = invalid ? 'Start sign-in from Account & sync.' : error;
  return <View style={{ padding: 24 }}><Text accessibilityRole={message ? 'alert' : undefined}>{message || 'Finishing sign-in…'}</Text></View>;
}
