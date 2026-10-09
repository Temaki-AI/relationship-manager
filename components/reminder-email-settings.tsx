'use client';

import { useEffect, useState } from 'react';
import { Mail } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { getResponseErrorMessage } from '@/lib/utils';

type Settings = {
  available: boolean;
  verifiedEmail: boolean;
  enabled: boolean;
  timeZone: string;
  quietStartHour: number;
  quietEndHour: number;
  failedCount: number;
  lastSentAt: string | null;
};

const hours = Array.from({ length: 24 }, (_, hour) => hour);

export function ReminderEmailSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    let active = true;
    fetch('/api/reminders/email-preferences', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Email alert settings could not load.'));
        return response.json() as Promise<Settings>;
      })
      .then((data) => {
        if (!active) return;
        setSettings({ ...data, timeZone: data.timeZone === 'UTC'
          ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' : data.timeZone });
      })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'Email alert settings could not load.'); });
    return () => { active = false; };
  }, []);

  async function save(enabled: boolean) {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/reminders/email-preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, timeZone: settings.timeZone,
          quietStartHour: settings.quietStartHour, quietEndHour: settings.quietEndHour }),
      });
      if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Could not save email alert settings.'));
      setSettings(await response.json() as Settings);
      toast({ message: enabled ? 'Email alerts enabled' : 'Email alerts turned off' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save email alert settings.');
    } finally { setSaving(false); }
  }

  return (
    <Card className="border-border/70 shadow-card animate-fade-in-up">
      <CardContent className="space-y-4 py-5">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-blue-50 p-2.5 text-blue-600"><Mail className="h-5 w-5" aria-hidden="true" /></div>
          <div>
            <h2 className="text-sm font-semibold">Email alerts</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Get an email for due reminders and contact or child birthday alerts even when the app is closed. Child birthdays use a seven-day heads-up. Events due together are bundled without names, titles, or notes.
              Delivery may be delayed, including until quiet hours end.
            </p>
          </div>
        </div>
        {!settings && !error && <p className="text-xs text-muted-foreground">Checking availability...</p>}
        {settings && !settings.available && (
          <p className="text-xs text-muted-foreground" role="status">
            {settings.verifiedEmail
              ? 'Email delivery is not set up yet. Browser alerts and your in-app list still work.'
              : 'Verify your account email before turning on email reminders.'}
          </p>
        )}
        {settings && (settings.available || settings.enabled) && (
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
            <label className="text-xs font-medium">Time zone
              <input className="mt-1 block h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
                value={settings.timeZone} disabled={!settings.available || saving}
                onChange={(event) => setSettings({ ...settings, timeZone: event.target.value })}
                aria-describedby="email-time-zone-hint" />
              <span id="email-time-zone-hint" className="mt-1 block font-normal text-muted-foreground">IANA zone, such as Europe/Lisbon</span>
            </label>
            <label className="text-xs font-medium">Quiet from
              <select className="mt-1 block h-10 rounded-lg border border-input bg-background px-2 text-sm"
                value={settings.quietStartHour} disabled={!settings.available || saving}
                onChange={(event) => setSettings({ ...settings, quietStartHour: Number(event.target.value) })}>
                {hours.map((hour) => <option key={hour} value={hour}>{String(hour).padStart(2, '0')}:00</option>)}
              </select>
            </label>
            <label className="text-xs font-medium">Until
              <select className="mt-1 block h-10 rounded-lg border border-input bg-background px-2 text-sm"
                value={settings.quietEndHour} disabled={!settings.available || saving}
                onChange={(event) => setSettings({ ...settings, quietEndHour: Number(event.target.value) })}>
                {hours.map((hour) => <option key={hour} value={hour}>{String(hour).padStart(2, '0')}:00</option>)}
              </select>
            </label>
            <div className="flex gap-2">
              {settings.enabled && settings.available && (
                <Button className="h-10" disabled={saving} onClick={() => void save(true)}>
                  {saving ? 'Saving...' : 'Save hours'}
                </Button>
              )}
              <Button className="h-10" disabled={saving || (!settings.available && !settings.enabled)}
                variant={settings.enabled ? 'outline' : 'default'}
                onClick={() => void save(!settings.enabled)}>
                {saving ? 'Saving...' : settings.enabled ? 'Turn off email' : 'Enable email'}
              </Button>
            </div>
          </div>
        )}
        {settings?.enabled && settings.available && (
          <p className="text-xs text-success" role="status">Email alerts are on for due reminders and contact or child birthdays. Quiet hours use your selected time zone.</p>
        )}
        {settings && settings.failedCount > 0 && (
          <p className="text-xs text-amber-800" role="status">
            {settings.failedCount} {settings.failedCount === 1 ? 'email alert could' : 'email alerts could'} not be delivered after retries. Check Reminders and Calendar for anything due.
          </p>
        )}
        {settings?.lastSentAt && (
          <p className="text-xs text-muted-foreground">Last email sent {new Date(settings.lastSentAt).toLocaleString()}.</p>
        )}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
