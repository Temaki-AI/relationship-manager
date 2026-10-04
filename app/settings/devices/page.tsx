'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

type Device = { id: string; device_name: string; created_at: string; expires_at: string; revoked_at: string | null };
export default function ConnectedDevicesPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  async function load() {
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/v1/devices', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load connected phones.');
      setDevices(data.devices);
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to load connected phones.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  async function revoke(device: Device) {
    setBusy(device.id); setError('');
    try {
      const response = await fetch(`/api/v1/devices/${device.id}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to revoke this phone.');
      setDevices((previous) => previous.map((entry) => entry.id === device.id ? { ...entry, revoked_at: new Date().toISOString() } : entry));
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to revoke this phone.'); }
    finally { setBusy(''); }
  }
  return <div className="mx-auto max-w-2xl space-y-6 py-8">
    <Link href="/settings" className="text-sm underline">Back to Settings</Link>
    <h1 className="text-2xl font-semibold">Connected phones</h1>
    <p className="text-sm text-muted-foreground">Revoking stops future cloud access. An offline phone may still hold its local copy until you remove it on that device.</p>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {loading ? <p>Loading connected phones…</p> : <>
      {!devices.length && <p>No phones are connected. Start sign-in from the native app.</p>}
      {devices.map((device) => {
        const active = !device.revoked_at && Date.parse(device.expires_at) > Date.now();
        return <Card key={device.id}><CardContent className="flex flex-wrap items-center justify-between gap-4 pt-6">
          <div><h2 className="font-semibold">{device.device_name}</h2>
            <p className="text-sm text-muted-foreground">{device.revoked_at ? 'Access revoked' : active ? `Signed in until ${new Date(device.expires_at).toLocaleDateString()}` : 'Session expired'}</p></div>
          {active && <Button variant="outline" disabled={Boolean(busy)} onClick={() => revoke(device)}>{busy === device.id ? 'Revoking…' : 'Revoke access'}</Button>}
        </CardContent></Card>;
      })}
      <Button variant="outline" onClick={load}>Refresh</Button>
    </>}
  </div>;
}
