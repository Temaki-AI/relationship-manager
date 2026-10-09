'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const sections = {
  people: {
    label: 'People sections',
    routes: [
      { href: '/contacts', label: 'People' },
      { href: '/groups', label: 'Groups' },
      { href: '/smart-lists', label: 'Smart Lists' },
    ],
  },
  calendar: {
    label: 'Calendar sections',
    routes: [
      { href: '/calendar', label: 'Calendar' },
      { href: '/reminders', label: 'Reminders' },
    ],
  },
  settings: {
    label: 'Settings sections',
    routes: [
      { href: '/settings', label: 'Settings' },
      { href: '/integrations', label: 'Integrations' },
    ],
  },
} as const;

export function SectionNav() {
  const pathname = usePathname();
  const section = pathname === '/contacts' || pathname === '/groups' || pathname === '/smart-lists'
    ? sections.people
    : pathname === '/calendar' || pathname === '/reminders'
      ? sections.calendar
      : pathname === '/settings' || pathname === '/integrations'
        ? sections.settings
        : null;

  if (!section) return null;

  return (
    <nav aria-label={section.label} className="-mt-2 mb-5 flex gap-1 overflow-x-auto border-b border-border/70 pb-1">
      {section.routes.map((route) => (
        <Link
          key={route.href}
          href={route.href}
          aria-current={pathname === route.href ? 'page' : undefined}
          className={`relative inline-flex min-h-11 shrink-0 items-center rounded-t-lg px-3 py-2.5 text-sm font-medium transition-colors ${pathname === route.href
            ? 'text-primary after:absolute after:inset-x-0 after:bottom-[-4px] after:h-0.5 after:bg-primary'
            : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'}`}
        >
          {route.label}
        </Link>
      ))}
    </nav>
  );
}
