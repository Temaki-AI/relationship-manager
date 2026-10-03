'use client';

import { useEffect } from 'react';

export function PwaProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (
      process.env.NODE_ENV !== 'production'
      || !window.isSecureContext
      || !('serviceWorker' in navigator)
    ) {
      return;
    }

    navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    }).then((registration) => registration.update()).catch(() => {
      // Install support is optional; the online CRM remains fully functional.
    });
  }, []);

  return children;
}
