import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Disclosure({ title, children, className, open }: {
  title: string; children: ReactNode; className?: string; open?: boolean;
}) {
  return <details open={open} className={cn('group rounded-xl border border-border/70 bg-card', className)}>
    <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-5 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
      {title}<ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
    </summary>
    <div className="border-t border-border/70 px-5 py-4">{children}</div>
  </details>;
}
