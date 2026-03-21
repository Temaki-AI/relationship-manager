'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Plus, Search } from 'lucide-react';
import type { Contact } from '@/lib/db';
import { formatRelativeDate, calculateRelationshipHealth, getHealthColor, parseTags } from '@/lib/utils';

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [filteredContacts, setFilteredContacts] = useState<Contact[]>([]);
  const [search, setSearch] = useState('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchContacts() {
      try {
        const res = await fetch('/api/contacts');
        const data = await res.json();
        setContacts(data.contacts);
        setFilteredContacts(data.contacts);
      } catch (error) {
        console.error('Failed to fetch contacts:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchContacts();
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

  // Get all unique tags
  const allTags = Array.from(
    new Set(contacts.flatMap((c) => parseTags(c.tags)))
  ).sort();

  if (loading) {
    return <div className="text-center py-12">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold">Contacts</h1>
        <Link href="/contacts/new">
          <Button>
            <Plus className="w-4 h-4 mr-2" />
            Add Contact
          </Button>
        </Link>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="space-y-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
              <Input
                type="text"
                placeholder="Search contacts..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-10"
              />
            </div>

            {allTags.length > 0 && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant={selectedTag === null ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setSelectedTag(null)}
                >
                  All
                </Button>
                {allTags.map((tag) => (
                  <Button
                    key={tag}
                    variant={selectedTag === tag ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setSelectedTag(tag)}
                  >
                    {tag}
                  </Button>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Results */}
      <div className="text-sm text-gray-600">
        Showing {filteredContacts.length} of {contacts.length} contacts
      </div>

      {/* Contact List */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredContacts.map((contact) => {
          const health = calculateRelationshipHealth(contact);
          const tags = parseTags(contact.tags);

          return (
            <Link key={contact.id} href={`/contacts/${contact.id}`}>
              <Card className="hover:shadow-lg transition-shadow h-full">
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <CardTitle className="text-lg">{contact.name}</CardTitle>
                      {contact.email && (
                        <p className="text-sm text-gray-500 truncate">{contact.email}</p>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {/* Relationship Health */}
                    <div>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-gray-600">Relationship Health</span>
                        <span className="font-medium">{health}%</span>
                      </div>
                      <div className="w-full bg-gray-200 rounded-full h-2">
                        <div
                          className={`h-2 rounded-full ${
                            health >= 75
                              ? 'bg-green-500'
                              : health >= 50
                              ? 'bg-yellow-500'
                              : 'bg-red-500'
                          }`}
                          style={{ width: `${health}%` }}
                        />
                      </div>
                    </div>

                    {/* Last Contact */}
                    <p className="text-sm text-gray-600">
                      Last contact: {formatRelativeDate(contact.last_contacted)}
                    </p>

                    {/* Tags */}
                    {tags.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {tags.map((tag) => (
                          <Badge key={tag} variant="outline" className="text-xs">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>

      {filteredContacts.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-gray-500">
            No contacts found. Try adjusting your filters.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
