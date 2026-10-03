'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { CalendarDays, Heart, Home, Users, FolderOpen, Bell, Sparkles, PlugZap, LogOut, Menu, Settings } from 'lucide-react';
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
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!mobileMenuRef.current?.contains(event.target as Node)) setMobileMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileMenuOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [mobileMenuOpen]);

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
      setMobileMenuOpen(false);
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
        : pathname.startsWith('/settings') || pathname.startsWith('/integrations');

  if (pathname === '/login') return null;

  return (
    <>
      {/* Desktop Header */}
      <header className="bg-white sm:bg-white/80 sm:backdrop-blur-md border-b border-border/50 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <Link href="/" className="flex items-center gap-2.5 group">
              <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center shadow-sm group-hover:shadow-md transition-shadow">
                <Heart className="w-4 h-4 text-white fill-white" />
              </div>
              <span className="text-lg font-semibold bg-gradient-to-r from-primary to-primary/70 bg-clip-text text-transparent">
                Everclose CRM
              </span>
            </Link>
            <nav className="hidden sm:flex items-center gap-1">
              {navItems.map((item) => {
                const isActive = isNavActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={isActive ? 'page' : undefined}
                    className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-all duration-200 ${
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
                  className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                  aria-label={signingOut ? 'Signing out' : 'Sign out'}
                  title={signingOut ? 'Signing out' : 'Sign out'}
                >
                  <LogOut className="h-4 w-4" />
                </button>
              )}
            </nav>
            <div ref={mobileMenuRef} className="relative flex items-center sm:hidden">
              <button
                type="button"
                onClick={() => setMobileMenuOpen((open) => !open)}
                className={`flex h-11 w-11 items-center justify-center rounded-xl transition-colors ${
                  mobileMenuOpen
                  || pathname.startsWith('/groups')
                  || pathname.startsWith('/smart-lists')
                  || pathname.startsWith('/reminders')
                  || pathname.startsWith('/integrations')
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                }`}
                aria-label="More navigation"
                aria-expanded={mobileMenuOpen}
                aria-controls="mobile-more-menu"
              >
                <Menu className="h-5 w-5" />
              </button>
              {mobileMenuOpen && (
                <div
                  id="mobile-more-menu"
                  className="absolute right-0 top-12 z-50 w-56 overflow-hidden rounded-xl border border-border/70 bg-white p-1.5 shadow-xl"
                >
                  {[
                    { href: '/smart-lists', label: 'Smart Lists', icon: Sparkles },
                    { href: '/groups', label: 'Groups', icon: FolderOpen },
                    { href: '/reminders', label: 'Reminders', icon: Bell },
                    { href: '/integrations', label: 'Integrations', icon: PlugZap },
                  ].map((item) => {
                    const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        aria-current={isActive ? 'page' : undefined}
                        className={`flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium ${
                          isActive
                            ? 'bg-primary/10 text-primary'
                            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                        }`}
                      >
                        <item.icon className="h-4 w-4" />
                        {item.label}
                      </Link>
                    );
                  })}
                  {showLogout && (
                    <>
                      <div className="my-1 h-px bg-border/70" />
                      <button
                        type="button"
                        onClick={handleLogout}
                        disabled={signingOut}
                        className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                      >
                        <LogOut className="h-4 w-4" />
                        {signingOut ? 'Signing out...' : 'Sign out'}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Mobile Bottom Nav */}
      <nav className="sm:hidden fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur-md border-t border-border/50 z-50 pb-safe">
        <div className="flex items-center justify-around h-16 px-4">
          {navItems.map((item) => {
            const isActive = isNavActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? 'page' : undefined}
                className={`flex flex-col items-center gap-1 px-3 py-1.5 rounded-xl transition-all ${
                  isActive ? 'text-primary' : 'text-muted-foreground'
                }`}
              >
                <item.icon className={`w-5 h-5 ${isActive ? 'stroke-[2.5]' : ''}`} />
                <span className="text-[10px] font-medium">{item.label}</span>
              </Link>
            );
          })}
          <AddActionMenu mobile />
        </div>
      </nav>
    </>
  );
}
