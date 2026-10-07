'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { CalendarDays, Heart, Home, Users, LogOut, Settings } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { cloudAuthClient } from '@/lib/cloud/auth-client';
import { clearContactSessionDrafts } from '@/lib/contact-form-draft';
import { AddActionMenu } from '@/components/add-action-menu';

const googleAuthEnabled = process.env.NEXT_PUBLIC_AUTH_MODE === 'google';

export function NavHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const [showLogout, setShowLogout] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (pathname === '/login') return;
    if (googleAuthEnabled) {
      cloudAuthClient.getSession()
        .then(({ data }) => setShowLogout(Boolean(data?.session)))
        .catch(() => setShowLogout(false));
      return;
    }
    fetch('/api/auth/session', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => setShowLogout(data.mode === 'enabled' && data.authenticated))
      .catch(() => setShowLogout(false));
  }, [pathname]);

  async function handleLogout() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      if (googleAuthEnabled) {
        const { error } = await cloudAuthClient.signOut();
        if (error) throw error;
      } else {
        const response = await fetch('/api/auth/logout', { method: 'POST' });
        if (!response.ok) throw new Error(`Sign-out failed with ${response.status}`);
      }
      clearContactSessionDrafts();
      setShowLogout(false);
      router.replace('/login');
      router.refresh();
    } catch {
      toast({
        message: 'Everclose CRM could not sign out. Your session is still active; try again.',
        variant: 'error',
      });
    } finally {
      setSigningOut(false);
    }
  }
  
  const navItems = [
    { href: '/', label: 'Today', icon: Home },
    { href: '/contacts', label: 'People', icon: Users },
    { href: '/calendar', label: 'Calendar', icon: CalendarDays },
    { href: '/settings', label: 'Settings', icon: Settings },
  ];
  const isNavActive = (href: string) => href === '/'
    ? pathname === '/'
    : href === '/contacts'
      ? pathname.startsWith('/contacts') || pathname.startsWith('/groups') || pathname.startsWith('/smart-lists')
      : href === '/calendar'
        ? pathname.startsWith('/calendar') || pathname.startsWith('/reminders')
        : pathname.startsWith('/settings') || pathname.startsWith('/integrations') || pathname.startsWith('/connections');

  if (pathname === '/login') return null;

  return (
    <>
      {/* Desktop Header */}
      <header className="bg-white/95 backdrop-blur-md border-b border-border/70 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <Link href="/" aria-label="Everclose home" className="flex min-h-11 items-center gap-2.5 group">
              <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center shadow-sm group-hover:shadow-md transition-shadow">
                <Heart className="w-4 h-4 text-white fill-white" />
              </div>
              <span className="text-lg font-semibold bg-gradient-to-r from-primary to-primary/70 bg-clip-text text-transparent">
                Everclose
              </span>
            </Link>
            <nav aria-label="Main navigation" className="hidden md:flex items-center gap-1">
              {navItems.map((item) => {
                const isActive = isNavActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={isActive ? 'page' : undefined}
                    className={`flex min-h-11 items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
                      isActive
                        ? 'bg-primary/10 text-rose-800'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                    }`}
                  >
                    <item.icon className="w-4 h-4" />
                    {item.label}
                  </Link>
                );
              })}
              <div className="w-px h-6 bg-border mx-2" />
              <AddActionMenu />
              {showLogout && (
                <button
                  type="button"
                  onClick={handleLogout}
                  disabled={signingOut}
                  className="flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                  aria-label={signingOut ? 'Signing out' : 'Sign out'}
                  title={signingOut ? 'Signing out' : 'Sign out'}
                >
                  <LogOut className="h-4 w-4" />
                </button>
              )}
            </nav>
            <div className="flex items-center gap-1 md:hidden">
              <AddActionMenu mobile />
              {showLogout && pathname.startsWith('/settings') && <button type="button" onClick={handleLogout}
                disabled={signingOut} aria-label={signingOut ? 'Signing out' : 'Sign out'}
                className="flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted">
                <LogOut className="h-5 w-5" aria-hidden="true" />
              </button>}
            </div>
          </div>
        </div>
      </header>

      {/* Mobile Bottom Nav */}
      <nav aria-label="Main navigation" className="md:hidden fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur-md border-t border-border/70 z-50 pb-safe">
        <div className="grid grid-cols-4 h-16 px-2">
          {navItems.map((item) => {
            const isActive = isNavActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? 'page' : undefined}
                className={`flex min-h-12 flex-col items-center justify-center gap-1 px-1 py-2 rounded-xl transition-colors ${
                  isActive ? 'text-primary' : 'text-muted-foreground'
                }`}
              >
                <item.icon className={`w-5 h-5 ${isActive ? 'stroke-[2.5]' : ''}`} />
                <span className="text-xs font-medium">{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
