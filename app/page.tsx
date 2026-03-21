'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Users, MessageSquare, AlertCircle, Cake, ArrowRight } from 'lucide-react';
import type { Contact } from '@/lib/db';
import { formatRelativeDate, calculateRelationshipHealth, parseTags } from '@/lib/utils';

type Stats = {
  totalContacts: number;
  conversationsThisWeek: number;
  neglectedCount: number;
  upcomingBirthdaysCount: number;
};

type Birthday = {
  id: number;
  name: string;
  birthday: string;
  daysUntil: number;
};

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [actionItems, setActionItems] = useState<Contact[]>([]);
  const [birthdays, setBirthdays] = useState<Birthday[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const [statsRes, contactsRes] = await Promise.all([
          fetch('/api/stats'),
          fetch('/api/contacts')
        ]);

        const statsData = await statsRes.json();
        const contactsData = await contactsRes.json();

        setStats(statsData.stats);
        setBirthdays(statsData.upcomingBirthdays || []);

        // Get full contact details for action items
        const actionContacts = contactsData.contacts.filter((c: Contact) =>
          statsData.actionItems.includes(c.id)
        );
        setActionItems(actionContacts);
      } catch (error) {
        console.error('Failed to fetch dashboard data:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, []);

  if (loading) {
    return <div className="text-center py-12">Loading...</div>;
  }

  return (
    <div className="space-y-8">
      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Contacts</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.totalContacts || 0}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">This Week</CardTitle>
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.conversationsThisWeek || 0}</div>
            <p className="text-xs text-muted-foreground">conversations</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Neglected</CardTitle>
            <AlertCircle className="h-4 w-4 text-red-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{stats?.neglectedCount || 0}</div>
            <p className="text-xs text-muted-foreground">&gt;30 days</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Upcoming Birthdays</CardTitle>
            <Cake className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.upcomingBirthdaysCount || 0}</div>
            <p className="text-xs text-muted-foreground">next 30 days</p>
          </CardContent>
        </Card>
      </div>

      {/* Action Items */}
      {actionItems.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>⚠️ Action Items</CardTitle>
            <CardDescription>People you should reach out to</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {actionItems.map((contact) => {
                const health = calculateRelationshipHealth(contact);
                return (
                  <div
                    key={contact.id}
                    className="flex items-center justify-between p-4 border rounded-lg hover:bg-gray-50"
                  >
                    <div className="flex-1">
                      <Link href={`/contacts/${contact.id}`} className="font-medium hover:underline">
                        {contact.name}
                      </Link>
                      <p className="text-sm text-gray-500">
                        Last contact: {formatRelativeDate(contact.last_contacted)}
                      </p>
                      {parseTags(contact.tags).length > 0 && (
                        <div className="flex gap-1 mt-1">
                          {parseTags(contact.tags).map((tag) => (
                            <Badge key={tag} variant="outline" className="text-xs">
                              {tag}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                    <Link href={`/contacts/${contact.id}`}>
                      <Button variant="outline" size="sm">
                        <ArrowRight className="w-4 h-4" />
                      </Button>
                    </Link>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Upcoming Birthdays */}
      {birthdays.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>🎂 Upcoming Birthdays</CardTitle>
            <CardDescription>Next 30 days</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {birthdays.map((birthday) => (
                <div
                  key={birthday.id}
                  className="flex items-center justify-between p-3 border rounded-lg"
                >
                  <div>
                    <Link href={`/contacts/${birthday.id}`} className="font-medium hover:underline">
                      {birthday.name}
                    </Link>
                    <p className="text-sm text-gray-500">
                      {birthday.daysUntil === 0
                        ? 'Today! 🎉'
                        : birthday.daysUntil === 1
                        ? 'Tomorrow'
                        : `In ${birthday.daysUntil} days`}
                    </p>
                  </div>
                  <Badge>{birthday.birthday.substring(5)}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-4">
            <Link href="/contacts/new">
              <Button>Add Contact</Button>
            </Link>
            <Link href="/contacts">
              <Button variant="outline">View All Contacts</Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
