'use client';

import { ToastProvider } from '@/components/ui/toast';
import { ReminderNotificationProvider } from '@/components/reminder-notification-provider';
import { PwaProvider } from '@/components/pwa-provider';
import { NavigationGuardProvider } from '@/components/navigation-guard-provider';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <NavigationGuardProvider>
        <PwaProvider>
          <ReminderNotificationProvider>{children}</ReminderNotificationProvider>
        </PwaProvider>
      </NavigationGuardProvider>
    </ToastProvider>
  );
}
