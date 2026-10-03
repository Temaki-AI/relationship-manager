import { Heart } from 'lucide-react';

export default function Loading() {
  return (
    <div
      className="mx-auto flex min-h-[55vh] max-w-3xl flex-col items-center justify-center text-center"
      aria-busy="true"
      aria-live="polite"
    >
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary animate-pulse-gentle">
        <Heart className="h-6 w-6 fill-current" aria-hidden="true" />
      </div>
      <h1 className="sr-only">Loading Everclose CRM</h1>
      <p className="mt-4 text-sm font-medium text-muted-foreground">Bringing your relationships into focus...</p>
      <div className="mt-6 grid w-full gap-3 sm:grid-cols-3" aria-hidden="true">
        <div className="skeleton h-24 rounded-xl" />
        <div className="skeleton h-24 rounded-xl" />
        <div className="skeleton h-24 rounded-xl" />
      </div>
    </div>
  );
}
