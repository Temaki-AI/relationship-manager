'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import {
  accountNotificationStorageKey,
  BIRTHDAY_NOTIFICATION_LEDGER_KEY,
  parseBirthdayNotificationLedger,
  prepareReminderNotificationCheck,
  prepareBirthdayNotificationCheck,
  parseReminderNotificationLedger,
  REMINDER_NOTIFICATION_LEDGER_KEY,
  REMINDER_NOTIFICATION_POLL_INTERVAL_MS,
  REMINDER_NOTIFICATION_PREFERENCE_KEY,
  type BirthdayNotificationCandidate,
  type ReminderNotificationCandidate,
} from '@/lib/reminder-notifications';

export type ReminderNotificationStatus = 'loading' | 'unavailable' | 'unsupported' | 'disabled' | 'denied' | 'enabled';

type ReminderNotificationContextValue = {
  status: ReminderNotificationStatus;
  enable: () => Promise<ReminderNotificationStatus>;
  disable: () => void;
};

const ReminderNotificationContext = createContext<ReminderNotificationContextValue | null>(null);

function durableBrowserStorageSupported(): boolean {
  const testKey = 'bonds-reminder-notification-storage-test';
  try {
    window.localStorage.setItem(testKey, '1');
    window.localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

function browserNotificationsSupported(): boolean {
  return window.isSecureContext
    && 'Notification' in window
    && durableBrowserStorageSupported();
}

async function verifiedAccountScope(): Promise<string | null> {
  try {
    if (process.env.NEXT_PUBLIC_AUTH_MODE === 'google') {
      const response = await fetch('/api/auth/get-session', { cache: 'no-store' });
      if (!response.ok) return null;
      const data = await response.json() as { user?: { id?: unknown } };
      const id = data.user?.id;
      return typeof id === 'string' && id.length > 0 && id.length <= 160 ? `google:${id}` : null;
    }
    const response = await fetch('/api/auth/session', { cache: 'no-store' });
    if (!response.ok) return null;
    const data = await response.json() as { authenticated?: boolean; mode?: string };
    if (data.mode === 'disabled') return 'local:disabled';
    return data.mode === 'enabled' && data.authenticated ? 'local:password' : null;
  } catch {
    return null;
  }
}

function readPreference(scope: string): boolean {
  try {
    return window.localStorage.getItem(accountNotificationStorageKey(REMINDER_NOTIFICATION_PREFERENCE_KEY, scope)) === 'true';
  } catch {
    return false;
  }
}

function writePreference(scope: string, enabled: boolean) {
  try {
    window.localStorage.setItem(accountNotificationStorageKey(REMINDER_NOTIFICATION_PREFERENCE_KEY, scope), String(enabled));
  } catch {
    // Browser storage can be unavailable in hardened or private contexts.
  }
}

function readLedger(scope: string): string[] {
  try {
    return parseReminderNotificationLedger(window.localStorage.getItem(accountNotificationStorageKey(REMINDER_NOTIFICATION_LEDGER_KEY, scope)));
  } catch {
    return [];
  }
}

function writeLedger(scope: string, ledger: string[]) {
  try {
    window.localStorage.setItem(accountNotificationStorageKey(REMINDER_NOTIFICATION_LEDGER_KEY, scope), JSON.stringify(ledger));
  } catch {
    // Missing storage only affects cross-check deduplication, not reminder data.
  }
}

function readBirthdayLedger(scope: string): string[] {
  try {
    return parseBirthdayNotificationLedger(window.localStorage.getItem(accountNotificationStorageKey(BIRTHDAY_NOTIFICATION_LEDGER_KEY, scope)));
  } catch {
    return [];
  }
}

function writeBirthdayLedger(scope: string, ledger: string[]) {
  try {
    window.localStorage.setItem(accountNotificationStorageKey(BIRTHDAY_NOTIFICATION_LEDGER_KEY, scope), JSON.stringify(ledger));
  } catch {
    // Missing storage only affects cross-check deduplication, not contact data.
  }
}

function statusForAccount(scope: string | null): ReminderNotificationStatus {
  if (!scope) return 'unavailable';
  if (!browserNotificationsSupported()) return 'unsupported';
  if (window.Notification.permission === 'denied') {
    writePreference(scope, false);
    return 'denied';
  }
  return window.Notification.permission === 'granted' && readPreference(scope) ? 'enabled' : 'disabled';
}

export function ReminderNotificationProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<ReminderNotificationStatus>('loading');
  const [accountScope, setAccountScope] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function refreshAccount() {
      const scope = await verifiedAccountScope();
      if (cancelled) return;
      setAccountScope(scope);
      setStatus(statusForAccount(scope));
    }
    const refresh = () => { void refreshAccount(); };
    refresh();
    window.addEventListener('focus', refresh);
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(refresh, REMINDER_NOTIFICATION_POLL_INTERVAL_MS * 5);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (status !== 'enabled' || !accountScope) return;
    let cancelled = false;
    const scope = accountScope;

    async function performCheck() {
      try {
        const beforeScope = await verifiedAccountScope();
        if (beforeScope !== scope || cancelled) {
          if (!cancelled) {
            setAccountScope(beforeScope);
            setStatus(statusForAccount(beforeScope));
          }
          return;
        }
        const query = new URLSearchParams({ view: 'notifications', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
        const response = await fetch(`/api/reminders?${query}`, { cache: 'no-store' });
        if (!response.ok || cancelled) return;
        const payload = await response.json() as { reminders?: unknown; birthdays?: unknown };
        const afterScope = await verifiedAccountScope();
        if (afterScope !== scope || cancelled) {
          if (!cancelled) {
            setAccountScope(afterScope);
            setStatus(statusForAccount(afterScope));
          }
          return;
        }
        if (!Array.isArray(payload.reminders)) return;

        const reminders = payload.reminders.filter((entry): entry is ReminderNotificationCandidate => (
          !!entry
          && typeof entry === 'object'
          && Number.isInteger((entry as ReminderNotificationCandidate).id)
          && typeof (entry as ReminderNotificationCandidate).remind_at === 'string'
        ));
        const previousLedger = readLedger(scope);
        const check = prepareReminderNotificationCheck(reminders, previousLedger);
        const birthdays = Array.isArray(payload.birthdays)
          ? payload.birthdays.filter((entry): entry is BirthdayNotificationCandidate => (
              !!entry
              && typeof entry === 'object'
              && Number.isInteger((entry as BirthdayNotificationCandidate).id)
              && typeof (entry as BirthdayNotificationCandidate).occurrence === 'string'
            ))
          : [];
        const previousBirthdayLedger = readBirthdayLedger(scope);
        const birthdayCheck = prepareBirthdayNotificationCheck(birthdays, previousBirthdayLedger);
        writeLedger(scope, check.nextLedger);
        writeBirthdayLedger(scope, birthdayCheck.nextLedger);
        if ((check.newDueCount === 0 && birthdayCheck.newDueCount === 0) || cancelled) return;

        try {
          const onlyBirthdays = check.newDueCount === 0;
          const body = check.newDueCount > 0 && birthdayCheck.newDueCount > 0
            ? `${check.newDueCount} relationship reminder${check.newDueCount === 1 ? '' : 's'} and ${birthdayCheck.newDueCount} birthday alert${birthdayCheck.newDueCount === 1 ? '' : 's'} are due.`
            : onlyBirthdays
              ? birthdayCheck.newDueCount === 1
                ? 'A birthday alert is due. Open Everclose CRM to view it.'
                : `${birthdayCheck.newDueCount} birthday alerts are due. Open Everclose CRM to view them.`
              : check.newDueCount === 1
                ? 'A relationship reminder is due. Open Everclose CRM to view it.'
                : `${check.newDueCount} relationship reminders are due. Open Everclose CRM to view them.`;
          const notification = new window.Notification('Everclose CRM alert', {
            body,
            icon: '/icons/bonds-192.png',
            tag: 'bonds-due-alerts',
          });
          notification.onclick = () => {
            window.focus();
            window.location.assign(onlyBirthdays ? '/smart-lists' : '/reminders');
            notification.close();
          };
        } catch {
          writeLedger(scope, previousLedger);
          writeBirthdayLedger(scope, previousBirthdayLedger);
          writePreference(scope, false);
          setStatus('unsupported');
        }
      } catch {
        // A transient fetch failure is retried on the next poll or visibility change.
      }
    }

    async function checkWithCrossTabLock() {
      if ('locks' in navigator) {
        await navigator.locks.request(
          `bonds-reminder-notifications:${encodeURIComponent(scope)}`,
          { ifAvailable: true },
          async (lock) => { if (lock) await performCheck(); }
        );
        return;
      }
      await performCheck();
    }

    const check = () => { void checkWithCrossTabLock(); };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') check();
    };
    check();
    const timer = window.setInterval(check, REMINDER_NOTIFICATION_POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [status, accountScope]);

  async function enable(): Promise<ReminderNotificationStatus> {
    const scope = await verifiedAccountScope();
    if (!scope) {
      setAccountScope(null);
      setStatus('unavailable');
      return 'unavailable';
    }
    setAccountScope(scope);
    if (!browserNotificationsSupported()) {
      setStatus('unsupported');
      return 'unsupported';
    }

    try {
      const permission = window.Notification.permission === 'granted'
        ? 'granted'
        : await window.Notification.requestPermission();
      const currentScope = await verifiedAccountScope();
      if (currentScope !== scope) {
        setAccountScope(currentScope);
        const nextStatus = statusForAccount(currentScope);
        setStatus(nextStatus);
        return nextStatus;
      }
      if (permission === 'granted') {
        writePreference(scope, true);
        setStatus('enabled');
        return 'enabled';
      }
      writePreference(scope, false);
      const nextStatus = permission === 'denied' ? 'denied' : 'disabled';
      setStatus(nextStatus);
      return nextStatus;
    } catch {
      writePreference(scope, false);
      setStatus('unsupported');
      return 'unsupported';
    }
  }

  function disable() {
    if (accountScope) writePreference(accountScope, false);
    setStatus(accountScope ? 'disabled' : 'unavailable');
  }

  return (
    <ReminderNotificationContext.Provider value={{ status, enable, disable }}>
      {children}
    </ReminderNotificationContext.Provider>
  );
}

export function useReminderNotifications() {
  const context = useContext(ReminderNotificationContext);
  if (!context) throw new Error('useReminderNotifications must be used within ReminderNotificationProvider');
  return context;
}
