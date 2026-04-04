'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Heart, Home, Users, FolderOpen, Bell, Plus } from 'lucide-react';

export function NavHeader() {
  const pathname = usePathname();
  
  const navItems = [
    { href: '/', label: 'Dashboard', icon: Home },
    { href: '/contacts', label: 'Contacts', icon: Users },
    { href: '/groups', label: 'Groups', icon: FolderOpen },
    { href: '/reminders', label: 'Reminders', icon: Bell },
  ];

  return (
    <>
      {/* Desktop Header */}
      <header className="bg-white/80 backdrop-blur-md border-b border-border/50 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <Link href="/" className="flex items-center gap-2.5 group">
              <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center shadow-sm group-hover:shadow-md transition-shadow">
                <Heart className="w-4 h-4 text-white fill-white" />
              </div>
              <span className="text-lg font-semibold bg-gradient-to-r from-primary to-primary/70 bg-clip-text text-transparent">
                Bonds
              </span>
            </Link>
            <nav className="hidden sm:flex items-center gap-1">
              {navItems.map((item) => {
                const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-all duration-200 ${
                      isActive
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                    }`}
                  >
                    <item.icon className="w-4 h-4" />
                    {item.label}
                  </Link>
                );
              })}
              <div className="w-px h-6 bg-border mx-2" />
              <Link
                href="/contacts/new"
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-primary text-white hover:bg-primary/90 transition-colors shadow-sm hover:shadow"
              >
                <Plus className="w-4 h-4" />
                Add Contact
              </Link>
            </nav>
          </div>
        </div>
      </header>

      {/* Mobile Bottom Nav */}
      <nav className="sm:hidden fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur-md border-t border-border/50 z-50 pb-safe">
        <div className="flex items-center justify-around h-16 px-4">
          {navItems.map((item) => {
            const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex flex-col items-center gap-1 px-3 py-1.5 rounded-xl transition-all ${
                  isActive ? 'text-primary' : 'text-muted-foreground'
                }`}
              >
                <item.icon className={`w-5 h-5 ${isActive ? 'stroke-[2.5]' : ''}`} />
                <span className="text-[10px] font-medium">{item.label}</span>
              </Link>
            );
          })}
          <Link
            href="/contacts/new"
            className="flex flex-col items-center gap-1 px-3 py-1.5"
          >
            <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center shadow-lg shadow-primary/25 -mt-3">
              <Plus className="w-5 h-5 text-white" />
            </div>
          </Link>
        </div>
      </nav>
    </>
  );
}
