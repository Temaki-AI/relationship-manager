'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { ArrowLeft, UserPlus } from 'lucide-react';

export default function NewContact() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
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
    setSubmitting(true);

    try {
      const tagsArray = form.tags.split(',').map((t) => t.trim()).filter((t) => t);
      const giftIdeasArray = form.gift_ideas.split('\n').map((g) => g.trim()).filter((g) => g);

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
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="animate-fade-in">
        <Link href="/contacts" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="w-4 h-4" />
          Back
        </Link>
      </div>

      <div className="animate-fade-in-up">
        <h1 className="text-2xl sm:text-3xl font-bold">Add someone new ✨</h1>
        <p className="text-sm text-muted-foreground mt-1">Tell us about this person</p>
      </div>

      <form onSubmit={handleSubmit}>
        <Card className="animate-fade-in-up border-0 shadow-sm">
          <CardContent className="pt-6 space-y-6">
            {/* Basics */}
            <div className="space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">The basics</h3>
              <div>
                <Label htmlFor="name">Name</Label>
                <Input id="name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Who is this person?" className="mt-1" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="their@email.com" className="mt-1" />
                </div>
                <div>
                  <Label htmlFor="phone">Phone</Label>
                  <Input id="phone" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+1-555-0123" className="mt-1" />
                </div>
              </div>
            </div>

            <div className="border-t border-border/50" />

            {/* Dates & Frequency */}
            <div className="space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Staying in touch</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="birthday">Birthday</Label>
                  <Input id="birthday" type="date" value={form.birthday} onChange={(e) => setForm({ ...form, birthday: e.target.value })} className="mt-1" />
                </div>
                <div>
                  <Label htmlFor="frequency">Check in every</Label>
                  <div className="flex items-center gap-2 mt-1">
                    <Input id="frequency" type="number" min="1" value={form.contact_frequency} onChange={(e) => setForm({ ...form, contact_frequency: parseInt(e.target.value) })} className="w-20" />
                    <span className="text-sm text-muted-foreground">days</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="border-t border-border/50" />

            {/* Context */}
            <div className="space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Context</h3>
              <div>
                <Label htmlFor="how_we_met">How did you meet?</Label>
                <Input id="how_we_met" value={form.how_we_met} onChange={(e) => setForm({ ...form, how_we_met: e.target.value })} placeholder="Running club, conference, work..." className="mt-1" />
              </div>
              <div>
                <Label htmlFor="tags">Tags</Label>
                <Input id="tags" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="friend, work, tennis" className="mt-1" />
                <p className="text-[11px] text-muted-foreground mt-1">Separate with commas</p>
              </div>
              <div>
                <Label htmlFor="notes">Notes</Label>
                <Textarea id="notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Anything you want to remember about them..." rows={3} className="mt-1" />
              </div>
              <div>
                <Label htmlFor="gift_ideas">Gift ideas</Label>
                <Textarea id="gift_ideas" value={form.gift_ideas} onChange={(e) => setForm({ ...form, gift_ideas: e.target.value })} placeholder="Running shoes&#10;A good book&#10;Coffee subscription" rows={3} className="mt-1" />
                <p className="text-[11px] text-muted-foreground mt-1">One per line</p>
              </div>
            </div>

            <div className="border-t border-border/50" />

            <div className="flex gap-3 pt-1">
              <Button type="submit" disabled={submitting} className="shadow-sm">
                <UserPlus className="w-4 h-4 mr-2" />
                {submitting ? 'Adding...' : 'Add contact'}
              </Button>
              <Link href="/contacts">
                <Button type="button" variant="ghost">Cancel</Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </form>
    </div>
  );
}
