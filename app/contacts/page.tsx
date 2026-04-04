'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Search, Download, Upload, UserPlus, Sparkles } from 'lucide-react';
import type { Contact } from '@/lib/db';
import { formatRelativeDate, calculateRelationshipHealth, parseTags } from '@/lib/utils';
import { Avatar } from '@/components/ui/avatar';
import { useToast } from '@/components/ui/toast';

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {[1, 2, 3, 4, 5, 6].map(i => (
        <div key={i} className="skeleton h-44 rounded-xl" />
      ))}
    </div>
  );
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [filteredContacts, setFilteredContacts] = useState<Contact[]>([]);
  const [search, setSearch] = useState('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const { toast } = useToast();

  async function fetchContacts() {
    try {
      const res = await fetch('/api/contacts');
      const data = await res.json();
      setContacts(data.contacts);
      setFilteredContacts(data.contacts);
    } catch (error) {
      console.error('Failed to fetch contacts:', error);
    }
  }

  useEffect(() => {
    fetchContacts().finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    let filtered = contacts;

    if (search) {
      const searchLower = search.toLowerCase();
      filtered = filtered.filter(
        (c) =>
          c.name.toLowerCase().includes(searchLower) ||
          c.email?.toLowerCase().includes(searchLower) ||
          c.notes?.toLowerCase().includes(searchLower)
      );
    }

    if (selectedTag) {
      filtered = filtered.filter((c) => parseTags(c.tags).includes(selectedTag));
    }

    setFilteredContacts(filtered);
  }, [search, selectedTag, contacts]);

  const allTags = Array.from(
    new Set(contacts.flatMap((c) => parseTags(c.tags)))
  ).sort();

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex justify-between items-center">
          <div className="skeleton h-9 w-40" />
          <div className="skeleton h-9 w-32" />
        </div>
        <SkeletonGrid />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 animate-fade-in">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold">Your people</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {contacts.length} {contacts.length === 1 ? 'contact' : 'contacts'}
          </p>
        </div>
        <div className="flex gap-2">
          <a href="/api/export/csv" download>
            <Button variant="outline" size="sm" className="text-muted-foreground">
              <Download className="w-3.5 h-3.5 mr-1.5" />
              Export
            </Button>
          </a>
          <Button
            variant="outline"
            size="sm"
            className="text-muted-foreground"
            disabled={importing}
            onClick={() => document.getElementById('csv-import')?.click()}
          >
            <Upload className="w-3.5 h-3.5 mr-1.5" />
            {importing ? 'Importing...' : 'Import'}
          </Button>
          <input
            id="csv-import"
            type="file"
            accept=".csv"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setImporting(true);
              try {
                const formData = new FormData();
                formData.append('file', file);
                const res = await fetch('/api/import/csv', { method: 'POST', body: formData });
                const data = await res.json();
                if (res.ok) {
                  toast({ message: `Imported ${data.imported} contacts${data.skipped ? `, ${data.skipped} skipped` : ''}` });
                  await fetchContacts();
                } else {
                  toast({ message: data.error || 'Import failed', variant: 'error' });
                }
              } catch (error) {
                toast({ message: 'Failed to import CSV', variant: 'error' });
              } finally {
                setImporting(false);
                e.target.value = '';
              }
            }}
          />
          <Link href="/contacts/new">
            <Button size="sm">
              <UserPlus className="w-3.5 h-3.5 mr-1.5" />
              Add contact
            </Button>
          </Link>
        </div>
      </div>

      {/* Search & Filters */}
      <div className="space-y-3 animate-fade-in-up">
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4" />
          <Input
            type="text"
            placeholder="Search by name, email, or notes..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10 h-11 bg-white border-border/60 focus:border-primary/40 rounded-xl"
          />
        </div>

        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setSelectedTag(null)}
              className={`px-3 py-1 text-xs font-medium rounded-full transition-all ${
                selectedTag === null
                  ? 'bg-primary text-white shadow-sm'
                  : 'bg-muted text-muted-foreground hover:bg-muted/70'
              }`}
            >
              All
            </button>
            {allTags.map((tag) => (
              <button
                key={tag}
                onClick={() => setSelectedTag(tag)}
                className={`px-3 py-1 text-xs font-medium rounded-full transition-all ${
                  selectedTag === tag
                    ? 'bg-primary text-white shadow-sm'
                    : 'bg-muted text-muted-foreground hover:bg-muted/70'
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Contact Grid */}
      {filteredContacts.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 stagger-children">
          {filteredContacts.map((contact) => {
            const health = calculateRelationshipHealth(contact);
            const tags = parseTags(contact.tags);

            return (
              <Link key={contact.id} href={`/contacts/${contact.id}`}>
                <Card className="group hover:shadow-md border-0 shadow-sm transition-all duration-200 hover:-translate-y-0.5 h-full">
                  <CardContent className="pt-5 pb-4 px-4 sm:px-5">
                    <div className="flex items-start gap-3 mb-3">
                      <Avatar contact={contact} size="sm" className="w-11 h-11" />
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm group-hover:text-primary transition-colors truncate">
                          {contact.name}
                        </p>
                        {contact.email && (
                          <p className="text-xs text-muted-foreground truncate">{contact.email}</p>
                        )}
                      </div>
                    </div>

                    {/* Health Bar */}
                    <div className="mb-3">
                      <div className="flex justify-between text-[10px] mb-1">
                        <span className="text-muted-foreground">Health</span>
                        <span className={`font-semibold ${
                          health >= 75 ? 'text-emerald-600' : health >= 50 ? 'text-amber-600' : 'text-red-500'
                        }`}>{health}%</span>
                      </div>
                      <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                        <div
                          className={`h-full rounded-full animate-health-fill ${
                            health >= 75
                              ? 'bg-gradient-to-r from-emerald-400 to-green-500'
                              : health >= 50
                              ? 'bg-gradient-to-r from-amber-400 to-orange-500'
                              : 'bg-gradient-to-r from-red-400 to-rose-500'
                          }`}
                          style={{ width: `${health}%` }}
                        />
                      </div>
                    </div>

                    {/* Meta */}
                    <p className="text-[11px] text-muted-foreground mb-2">
                      {formatRelativeDate(contact.last_contacted)}
                    </p>

                    {/* Tags */}
                    {tags.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {tags.map((tag) => (
                          <span
                            key={tag}
                            className="inline-flex px-2 py-0.5 text-[10px] font-medium rounded-full bg-muted text-muted-foreground"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      ) : (
        <Card className="animate-scale-in border-0 shadow-sm">
          <CardContent className="py-16 text-center">
            {contacts.length === 0 ? (
              <>
                <div className="text-5xl mb-4">👥</div>
                <h3 className="text-lg font-semibold">No contacts yet</h3>
                <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
                  Add the people who matter to you and start tracking your relationships.
                </p>
                <Link href="/contacts/new">
                  <Button className="mt-4">
                    <Sparkles className="w-4 h-4 mr-2" />
                    Add your first contact
                  </Button>
                </Link>
              </>
            ) : (
              <>
                <div className="text-4xl mb-3">🔍</div>
                <h3 className="text-lg font-semibold">No matches</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Try adjusting your search or filters
                </p>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
