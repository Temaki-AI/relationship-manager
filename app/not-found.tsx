import Link from 'next/link';
import { ArrowLeft, Compass } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';

export default function NotFound() {
  return (
    <section className="mx-auto flex min-h-[55vh] max-w-xl flex-col items-center justify-center text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-warning-soft text-amber-600 shadow-sm">
        <Compass className="h-7 w-7" aria-hidden="true" />
      </div>
      <p className="mt-6 text-xs font-semibold uppercase tracking-[0.18em] text-primary">Page not found</p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">This connection leads nowhere.</h1>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground sm:text-base">
        The page may have moved or the address may be incomplete. Your CRM data is safe.
      </p>
      <Link href="/" className={buttonVariants({ className: 'mt-7' })}>
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to dashboard
      </Link>
    </section>
  );
}
