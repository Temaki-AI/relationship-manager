'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { ArrowLeft } from 'lucide-react';

export default function NewContact() {
  const router = useRouter();
  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    birthday: '',
    how_we_met: '',
    tags: '',
    notes: '',
    gift_ideas: '',
    contact_frequency: 14,
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    try {
      const tagsArray = form.tags
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t);

      const giftIdeasArray = form.gift_ideas
        .split('\n')
        .map((g) => g.trim())
        .filter((g) => g);

      const res = await fetch('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          tags: tagsArray,
          gift_ideas: giftIdeasArray,
          birthday: form.birthday || null,
        }),
      });

      if (res.ok) {
        const { contact } = await res.json();
        router.push(`/contacts/${contact.id}`);
      }
    } catch (error) {
      console.error('Failed to create contact:', error);
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/contacts">
          <Button variant="outline">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back
          </Button>
        </Link>
        <h1 className="text-3xl font-bold">Add Contact</h1>
      </div>

      <form onSubmit={handleSubmit}>
        <Card>
          <CardHeader>
            <CardTitle>Contact Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="John Doe"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  placeholder="john@example.com"
                />
              </div>
              <div>
                <Label htmlFor="phone">Phone</Label>
                <Input
                  id="phone"
                  type="tel"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  placeholder="+1-555-0123"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="birthday">Birthday</Label>
                <Input
                  id="birthday"
                  type="date"
                  value={form.birthday}
                  onChange={(e) => setForm({ ...form, birthday: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="frequency">Contact Frequency (days)</Label>
                <Input
                  id="frequency"
                  type="number"
                  min="1"
                  value={form.contact_frequency}
                  onChange={(e) => setForm({ ...form, contact_frequency: parseInt(e.target.value) })}
                />
              </div>
            </div>

            <div>
              <Label htmlFor="how_we_met">How We Met</Label>
              <Input
                id="how_we_met"
                value={form.how_we_met}
                onChange={(e) => setForm({ ...form, how_we_met: e.target.value })}
                placeholder="Conference 2024"
              />
            </div>

            <div>
              <Label htmlFor="tags">Tags (comma-separated)</Label>
              <Input
                id="tags"
                value={form.tags}
                onChange={(e) => setForm({ ...form, tags: e.target.value })}
                placeholder="friend, running, tech"
              />
            </div>

            <div>
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="Additional notes..."
                rows={4}
              />
            </div>

            <div>
              <Label htmlFor="gift_ideas">Gift Ideas (one per line)</Label>
              <Textarea
                id="gift_ideas"
                value={form.gift_ideas}
                onChange={(e) => setForm({ ...form, gift_ideas: e.target.value })}
                placeholder="Running shoes\nBook about AI\nCoffee subscription"
                rows={3}
              />
            </div>

            <div className="flex gap-2 pt-4">
              <Button type="submit">Create Contact</Button>
              <Link href="/contacts">
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </form>
    </div>
  );
}
