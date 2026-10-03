'use client';

import Link from 'next/link';
import { AlertTriangle, Home, RefreshCw } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section
      className="mx-auto flex min-h-[55vh] max-w-xl flex-col items-center justify-center text-center"
      role="alert"
      aria-labelledby="error-heading"
    >
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-rose-50 text-rose-600 shadow-sm">
        <AlertTriangle className="h-7 w-7" aria-hidden="true" />
      </div>
      <p className="mt-6 text-xs font-semibold uppercase tracking-[0.18em] text-primary">A temporary snag</p>
      <h1 id="error-heading" className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
        Everclose CRM could not finish that step.
      </h1>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground sm:text-base">
        Your saved relationship data has not been changed. Try again, or return to the dashboard.
      </p>
      <div className="mt-7 flex flex-col gap-2 sm:flex-row">
        <Button type="button" onClick={reset}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Try again
        </Button>
        <Link href="/" className={buttonVariants({ variant: 'outline' })}>
          <Home className="h-4 w-4" aria-hidden="true" />
          Dashboard
        </Link>
      </div>
      {error.digest && <p className="mt-5 text-xs text-muted-foreground">Reference: {error.digest}</p>}
    </section>
  );
}
