'use client';

import { useId } from 'react';
import Link from 'next/link';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

type LoadErrorProps = {
  title: string;
  message: string;
  onRetry: () => void;
  retrying?: boolean;
  backHref?: string;
  backLabel?: string;
};

export function LoadError({
  title,
  message,
  onRetry,
  retrying = false,
  backHref,
  backLabel = 'Go back',
}: LoadErrorProps) {
  const headingId = useId();

  return (
    <Card
      role="alert"
      aria-labelledby={headingId}
      className="border-warning/20 bg-warning-soft text-warning"
    >
      <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start">
        <AlertTriangle className="h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="font-semibold">{title}</h2>
          <p className="mt-1 text-sm leading-relaxed">{message}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={onRetry} disabled={retrying}>
              <RefreshCw className={`h-3.5 w-3.5 ${retrying ? 'animate-spin' : ''}`} aria-hidden="true" />
              {retrying ? 'Trying again...' : 'Try again'}
            </Button>
            {backHref && (
              <Link href={backHref} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                {backLabel}
              </Link>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
