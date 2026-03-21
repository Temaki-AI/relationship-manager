'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { ArrowLeft, Edit, Trash2, Phone, Mail, Calendar, MessageSquare, Coffee, Bell, Heart, MapPin, Gift, StickyNote, Plus } from 'lucide-react';
import type { Contact, Interaction } from '@/lib/db';
import { formatDate, formatRelativeDate, calculateRelationshipHealth, getHealthBadge, parseTags, parseGiftIdeas } from '@/lib/utils';
import { Avatar } from '@/components/ui/avatar';

export default function ContactDetail() {
  const params = useParams();
  const id = params.id as string;
  const router = useRouter();
  const [contact, setContact] = useState<Contact | null>(null);
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [showLogForm, setShowLogForm] = useState(false);
  const [showReminderForm, setShowReminderForm] = useState(false);
  const [interactionForm, setInteractionForm] = useState({
    type: 'call',
    date: new Date().toISOString().split('T')[0],
    summary: '',
    notes: '',
  });
  const [reminderForm, setReminderForm] = useState({
    title: '',
    notes: '',
    remind_at: '',
  });

  useEffect(() => {
    async function fetchContact() {
      try {
        const res = await fetch(`/api/contacts/${id}`);
        const data = await res.json();
        setContact(data.contact);
        setInteractions(data.interactions || []);
      } catch (error) {
        console.error('Failed to fetch contact:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchContact();
  }, [id]);

  async function handleLogInteraction(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await fetch('/api/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: id, ...interactionForm }),
      });

      if (res.ok) {
        const refreshRes = await fetch(`/api/contacts/${id}`);
        const data = await refreshRes.json();
        setContact(data.contact);
        setInteractions(data.interactions);
        setInteractionForm({ type: 'call', date: new Date().toISOString().split('T')[0], summary: '', notes: '' });
        setShowLogForm(false);
      }
    } catch (error) {
      console.error('Failed to log interaction:', error);
    }
  }

  async function handleDelete() {
    if (!confirm('Are you sure you want to delete this contact?')) return;
    try {
      await fetch(`/api/contacts/${id}`, { method: 'DELETE' });
      router.push('/contacts');
    } catch (error) {
      console.error('Failed to delete contact:', error);
    }
  }

  async function handleSetReminder(e: React.FormEvent) {
    e.preventDefault();
    try {
      await fetch('/api/reminders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: id, ...reminderForm }),
      });
      setReminderForm({ title: '', notes: '', remind_at: '' });
      setShowReminderForm(false);
    } catch (error) {
      console.error('Failed to set reminder:', error);
    }
  }

  const interactionTypeConfig: Record<string, { icon: React.ElementType; color: string; bg: string }> = {
    call: { icon: Phone, color: 'text-blue-600', bg: 'bg-blue-100' },
    message: { icon: MessageSquare, color: 'text-emerald-600', bg: 'bg-emerald-100' },
    meetup: { icon: Coffee, color: 'text-amber-600', bg: 'bg-amber-100' },
    email: { icon: Mail, color: 'text-purple-600', bg: 'bg-purple-100' },
  };

  if (loading) {
    return (
      <div className="space-y-6 max-w-3xl mx-auto">
        <div className="skeleton h-10 w-20" />
        <div className="flex items-center gap-4">
          <div className="skeleton w-20 h-20 rounded-full" />
          <div className="space-y-2">
            <div className="skeleton h-8 w-48" />
            <div className="skeleton h-4 w-32" />
          </div>
        </div>
        <div className="skeleton h-32 rounded-xl" />
        <div className="skeleton h-48 rounded-xl" />
      </div>
    );
  }

  if (!contact) {
    return (
      <div className="text-center py-16">
        <div className="text-4xl mb-3">😢</div>
        <h3 className="text-lg font-semibold">Contact not found</h3>
        <Link href="/contacts">
          <Button variant="outline" className="mt-4">Back to contacts</Button>
        </Link>
      </div>
    );
  }

  const health = calculateRelationshipHealth(contact);
  const tags = parseTags(contact.tags);
  const giftIdeas = parseGiftIdeas(contact.gift_ideas);

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Back button */}
      <div className="animate-fade-in">
        <Link href="/contacts" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="w-4 h-4" />
          Back
        </Link>
      </div>

      {/* Profile Header */}
      <div className="flex flex-col sm:flex-row items-start gap-4 sm:gap-5 animate-fade-in-up">
        <Avatar contact={contact} size="xl" />
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground">{contact.name}</h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-sm text-muted-foreground">
            {contact.email && (
              <a href={`mailto:${contact.email}`} className="flex items-center gap-1.5 hover:text-primary transition-colors">
                <Mail className="w-3.5 h-3.5" />
                {contact.email}
              </a>
            )}
            {contact.phone && (
              <a href={`tel:${contact.phone}`} className="flex items-center gap-1.5 hover:text-primary transition-colors">
                <Phone className="w-3.5 h-3.5" />
                {contact.phone}
              </a>
            )}
            {contact.birthday && (
              <span className="flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5" />
                {formatDate(contact.birthday)}
              </span>
            )}
          </div>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {tags.map((tag) => (
                <span key={tag} className="px-2.5 py-0.5 text-xs font-medium rounded-full bg-primary/10 text-primary">
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
        {/* Actions */}
        <div className="flex gap-2 sm:flex-shrink-0">
          <Button variant="outline" size="sm" onClick={() => setShowReminderForm(!showReminderForm)}>
            <Bell className="w-3.5 h-3.5" />
          </Button>
          <Link href={`/contacts/${id}/edit`}>
            <Button variant="outline" size="sm">
              <Edit className="w-3.5 h-3.5" />
            </Button>
          </Link>
          <Button variant="outline" size="sm" onClick={handleDelete} className="text-destructive hover:text-destructive hover:bg-destructive/10 hover:border-destructive/30">
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Reminder Form */}
      {showReminderForm && (
        <Card className="animate-slide-down border-primary/20 bg-primary/5">
          <CardContent className="pt-5 pb-4">
            <form onSubmit={handleSetReminder} className="space-y-3">
              <div className="flex items-center gap-2 mb-1">
                <Bell className="w-4 h-4 text-primary" />
                <span className="font-medium text-sm">Set a reminder</span>
              </div>
              <Input
                required
                placeholder="What to remember..."
                value={reminderForm.title}
                onChange={(e) => setReminderForm({ ...reminderForm, title: e.target.value })}
                className="bg-white"
              />
              <Input
                type="datetime-local"
                required
                value={reminderForm.remind_at}
                onChange={(e) => setReminderForm({ ...reminderForm, remind_at: e.target.value })}
                className="bg-white"
              />
              <Textarea
                placeholder="Notes (optional)"
                value={reminderForm.notes}
                onChange={(e) => setReminderForm({ ...reminderForm, notes: e.target.value })}
                rows={2}
                className="bg-white"
              />
              <div className="flex gap-2">
                <Button type="submit" size="sm">Save reminder</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setShowReminderForm(false)}>Cancel</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Health + How We Met row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 stagger-children">
        {/* Health Card */}
        <Card className="border-0 shadow-sm overflow-hidden relative">
          <div className={`absolute inset-0 opacity-5 ${
            health >= 75 ? 'bg-emerald-500' : health >= 50 ? 'bg-amber-500' : 'bg-red-500'
          }`} />
          <CardContent className="relative pt-5 pb-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Heart className={`w-4 h-4 ${
                  health >= 75 ? 'text-emerald-500 fill-emerald-500' : health >= 50 ? 'text-amber-500' : 'text-red-500'
                }`} />
                <span className="text-sm font-medium">{getHealthBadge(health)}</span>
              </div>
              <span className={`text-2xl font-bold ${
                health >= 75 ? 'text-emerald-600' : health >= 50 ? 'text-amber-600' : 'text-red-500'
              }`}>{health}%</span>
            </div>
            <div className="w-full bg-muted rounded-full h-2.5 overflow-hidden">
              <div
                className={`h-full rounded-full animate-health-fill ${
                  health >= 75 ? 'bg-gradient-to-r from-emerald-400 to-green-500'
                    : health >= 50 ? 'bg-gradient-to-r from-amber-400 to-orange-500'
                    : 'bg-gradient-to-r from-red-400 to-rose-500'
                }`}
                style={{ width: `${health}%` }}
              />
            </div>
            <div className="flex justify-between mt-2 text-xs text-muted-foreground">
              <span>{formatRelativeDate(contact.last_contacted)}</span>
              <span>Every {contact.contact_frequency}d</span>
            </div>
          </CardContent>
        </Card>

        {/* How We Met / Notes preview */}
        {(contact.how_we_met || contact.notes) && (
          <Card className="border-0 shadow-sm">
            <CardContent className="pt-5 pb-4">
              {contact.how_we_met && (
                <div className="mb-3">
                  <div className="flex items-center gap-1.5 mb-1">
                    <MapPin className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-xs font-medium text-muted-foreground">How you met</span>
                  </div>
                  <p className="text-sm text-foreground">{contact.how_we_met}</p>
                </div>
              )}
              {contact.notes && (
                <div>
                  <div className="flex items-center gap-1.5 mb-1">
                    <StickyNote className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-xs font-medium text-muted-foreground">Notes</span>
                  </div>
                  <p className="text-sm text-foreground line-clamp-3 whitespace-pre-wrap">{contact.notes}</p>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Gift Ideas */}
      {giftIdeas.length > 0 && (
        <Card className="animate-fade-in-up border-0 shadow-sm">
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-2 mb-3">
              <Gift className="w-4 h-4 text-amber-500" />
              <span className="text-sm font-semibold">Gift ideas</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {giftIdeas.map((idea, i) => (
                <span key={i} className="px-3 py-1 text-xs rounded-full bg-amber-50 text-amber-700 border border-amber-200/50">
                  {idea}
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Interactions */}
      <Card className="animate-fade-in-up border-0 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-muted-foreground" />
              <CardTitle className="text-base font-semibold">
                Interactions
                {interactions.length > 0 && (
                  <span className="text-muted-foreground font-normal ml-1.5 text-sm">({interactions.length})</span>
                )}
              </CardTitle>
            </div>
            <Button size="sm" onClick={() => setShowLogForm(!showLogForm)} className="shadow-sm">
              <Plus className="w-3.5 h-3.5 mr-1.5" />
              Log
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {showLogForm && (
            <form onSubmit={handleLogInteraction} className="animate-slide-down space-y-3 mb-6 p-4 rounded-xl bg-muted/40 border border-border/50">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Type</Label>
                  <select
                    className="w-full h-9 rounded-lg border border-input bg-white px-3 py-1 text-sm mt-1"
                    value={interactionForm.type}
                    onChange={(e) => setInteractionForm({ ...interactionForm, type: e.target.value })}
                  >
                    <option value="call">📞 Call</option>
                    <option value="message">💬 Message</option>
                    <option value="meetup">☕ Meetup</option>
                    <option value="email">✉️ Email</option>
                  </select>
                </div>
                <div>
                  <Label className="text-xs">Date</Label>
                  <Input
                    type="date"
                    value={interactionForm.date}
                    onChange={(e) => setInteractionForm({ ...interactionForm, date: e.target.value })}
                    className="mt-1 bg-white"
                  />
                </div>
              </div>
              <div>
                <Label className="text-xs">Summary</Label>
                <Input
                  placeholder="What happened?"
                  value={interactionForm.summary}
                  onChange={(e) => setInteractionForm({ ...interactionForm, summary: e.target.value })}
                  className="mt-1 bg-white"
                />
              </div>
              <div>
                <Label className="text-xs">Notes</Label>
                <Textarea
                  placeholder="Any details to remember..."
                  value={interactionForm.notes}
                  onChange={(e) => setInteractionForm({ ...interactionForm, notes: e.target.value })}
                  rows={2}
                  className="mt-1 bg-white"
                />
              </div>
              <div className="flex gap-2">
                <Button type="submit" size="sm">Save</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setShowLogForm(false)}>Cancel</Button>
              </div>
            </form>
          )}

          <div className="space-y-0">
            {interactions.length === 0 ? (
              <div className="text-center py-10">
                <div className="text-3xl mb-2">💬</div>
                <p className="text-sm text-muted-foreground">No interactions yet</p>
                <p className="text-xs text-muted-foreground mt-0.5">Log your first conversation above</p>
              </div>
            ) : (
              interactions.map((interaction, index) => {
                const config = interactionTypeConfig[interaction.type] || interactionTypeConfig.call;
                const Icon = config.icon;
                return (
                  <div key={interaction.id} className="flex gap-3 group">
                    {/* Timeline line + dot */}
                    <div className="flex flex-col items-center">
                      <div className={`w-8 h-8 rounded-full ${config.bg} flex items-center justify-center flex-shrink-0`}>
                        <Icon className={`w-3.5 h-3.5 ${config.color}`} />
                      </div>
                      {index < interactions.length - 1 && (
                        <div className="w-px flex-1 bg-border my-1" />
                      )}
                    </div>
                    {/* Content */}
                    <div className={`flex-1 pb-5 ${index < interactions.length - 1 ? '' : 'pb-0'}`}>
                      <div className="flex items-baseline gap-2">
                        <span className="font-medium text-sm capitalize">{interaction.type}</span>
                        <span className="text-xs text-muted-foreground">{formatDate(interaction.date)}</span>
                      </div>
                      {interaction.summary && (
                        <p className="text-sm text-foreground mt-0.5">{interaction.summary}</p>
                      )}
                      {interaction.notes && (
                        <p className="text-xs text-muted-foreground mt-1">{interaction.notes}</p>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
