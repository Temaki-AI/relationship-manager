'use client';

import { AlertTriangle, RefreshCw } from 'lucide-react';
import './globals.css';

export default function GlobalError({ reset }: { reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <main className="flex min-h-screen items-center justify-center bg-background px-5 text-foreground">
          <section className="max-w-lg text-center" role="alert" aria-labelledby="global-error-heading">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-secondary text-primary shadow-sm">
              <AlertTriangle className="h-7 w-7" aria-hidden="true" />
            </div>
            <p className="mt-6 text-xs font-semibold uppercase tracking-[0.18em] text-primary">Everclose CRM needs a moment</p>
            <h1 id="global-error-heading" className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
              We could not open your relationship space.
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground sm:text-base">
              Your saved data remains on this device. Try loading the app again.
            </p>
            <button
              type="button"
              onClick={reset}
              className="mt-7 inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Reload Everclose CRM
            </button>
          </section>
        </main>
      </body>
    </html>
  );
}
