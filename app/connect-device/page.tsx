'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cloudAuthClient } from '@/lib/cloud/auth-client';
import { isDeviceSecret, isDeviceState, parseDeviceCallback } from '@/packages/domain/src/devices';

export default function ConnectDevicePage() {
  const [request, setRequest] = useState<{ challenge: string; state: string; deviceName: string } | null>(null);
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const challenge = query.get('challenge');
    const state = query.get('state');
    const deviceName = query.get('deviceName') || 'Everclose on iPhone';
    if (!isDeviceSecret(challenge) || !isDeviceState(state) || deviceName.length > 80) {
      setError('Start sign-in from the Everclose app on your phone.');
      return;
    }
    setRequest({ challenge, state, deviceName });
    cloudAuthClient.getSession().then(({ data }) => {
      if (data?.user) setEmail(data.user.email);
      else setError('Your web session expired. Start phone sign-in again.');
    }).catch(() => setError('Unable to check your account. Start phone sign-in again.'));
  }, []);
  async function approve() {
    if (!request) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/v1/devices/authorize', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to connect this phone.');
      parseDeviceCallback(body.callback, request.state);
      window.location.assign(body.callback);
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to connect this phone.'); }
    finally { setBusy(false); }
  }
  return <div className="mx-auto max-w-md py-12">
    <h1 className="mb-4 text-2xl font-semibold">Connect your phone</h1>
    <Card><CardContent className="space-y-5 pt-6">
      <p>{email ? <>Connect <strong>{request?.deviceName}</strong> to <strong>{email}</strong>.</> : 'Checking your account…'}</p>
      <p className="text-sm text-muted-foreground">This phone can keep an offline copy of your contacts, history, reminders, plans, family and relationships, and sync changes. You can revoke its access in Settings.</p>
      <p className="text-sm">Continue only if you started sign-in from your Everclose app.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button disabled={!request || !email || busy} className="w-full" onClick={approve}>{busy ? 'Connecting…' : 'Continue to my phone'}</Button>
      <Link href="/" className="block text-center text-sm underline">Cancel</Link>
    </CardContent></Card>
  </div>;
}
