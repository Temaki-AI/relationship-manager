'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bell, MessageSquare, Plus, UserPlus } from 'lucide-react';

const actions = [
  { href: '/contacts/new', label: 'Person', description: 'Add someone new', icon: UserPlus },
  { href: '/contacts?intent=log', label: 'Log moment', description: 'Choose someone to remember', icon: MessageSquare },
  { href: '/calendar?create=reminder', label: 'Reminder', description: 'Plan a future nudge', icon: Bell },
];

export function AddActionMenu({ mobile = false }: { mobile?: boolean }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        aria-label="Add"
        aria-expanded={open}
        aria-controls={mobile ? 'mobile-add-actions' : 'desktop-add-actions'}
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-11 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white transition-colors hover:bg-primary/90"
      >
        <Plus className="h-4 w-4" aria-hidden="true" />Add
      </button>
      <div
        id={mobile ? 'mobile-add-actions' : 'desktop-add-actions'}
        hidden={!open}
        className="absolute right-0 top-full mt-2 z-[60] w-64 rounded-xl border border-border/70 bg-white p-1.5 shadow-xl"
      >
        {actions.map((action) => (
          <Link
            key={action.href}
            href={action.href}
            onClick={() => setOpen(false)}
            className="flex min-h-12 items-center gap-3 rounded-lg px-3 py-2 text-foreground hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
          >
            <action.icon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <span className="min-w-0">
              <span className="block text-sm font-semibold">{action.label}</span>
              <span className="block text-xs text-muted-foreground">{action.description}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
