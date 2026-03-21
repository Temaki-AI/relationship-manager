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
import { ArrowLeft, Edit, Trash2, Phone, Mail, Calendar, MessageSquare, Video, Coffee, Bell } from 'lucide-react';
import type { Contact, Interaction } from '@/lib/db';
import { formatDate, formatRelativeDate, calculateRelationshipHealth, getHealthBadge, parseTags, parseGiftIdeas } from '@/lib/utils';

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
        body: JSON.stringify({
          contact_id: id,
          ...interactionForm,
        }),
      });

      if (res.ok) {
        // Refresh contact data
        const refreshRes = await fetch(`/api/contacts/${id}`);
        const data = await refreshRes.json();
        setContact(data.contact);
        setInteractions(data.interactions);
        
        // Reset form
        setInteractionForm({
          type: 'call',
          date: new Date().toISOString().split('T')[0],
          summary: '',
          notes: '',
        });
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
        body: JSON.stringify({
          contact_id: id,
          ...reminderForm,
        }),
      });

      setReminderForm({ title: '', notes: '', remind_at: '' });
      setShowReminderForm(false);
      alert('Reminder set!');
    } catch (error) {
      console.error('Failed to set reminder:', error);
    }
  }

  if (loading) {
    return <div className="text-center py-12">Loading...</div>;
  }

  if (!contact) {
    return <div className="text-center py-12">Contact not found</div>;
  }

  const health = calculateRelationshipHealth(contact);
  const tags = parseTags(contact.tags);
  const giftIdeas = parseGiftIdeas(contact.gift_ideas);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <Link href="/contacts">
          <Button variant="outline">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back
          </Button>
        </Link>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setShowReminderForm(!showReminderForm)}>
            <Bell className="w-4 h-4 mr-2" />
            Reminder
          </Button>
          <Link href={`/contacts/${id}/edit`}>
            <Button variant="outline">
              <Edit className="w-4 h-4 mr-2" />
              Edit
            </Button>
          </Link>
          <Button variant="destructive" onClick={handleDelete}>
            <Trash2 className="w-4 h-4 mr-2" />
            Delete
          </Button>
        </div>
      </div>

      {/* Contact Info Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">{contact.name}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {contact.email && (
            <div className="flex items-center gap-2 text-gray-600">
              <Mail className="w-4 h-4" />
              <a href={`mailto:${contact.email}`} className="hover:underline">
                {contact.email}
              </a>
            </div>
          )}

          {contact.phone && (
            <div className="flex items-center gap-2 text-gray-600">
              <Phone className="w-4 h-4" />
              <a href={`tel:${contact.phone}`} className="hover:underline">
                {contact.phone}
              </a>
            </div>
          )}

          {contact.birthday && (
            <div className="flex items-center gap-2 text-gray-600">
              <Calendar className="w-4 h-4" />
              <span>Birthday: {formatDate(contact.birthday)}</span>
            </div>
          )}

          {contact.how_we_met && (
            <div>
              <p className="text-sm font-medium text-gray-700">How we met</p>
              <p className="text-gray-600">{contact.how_we_met}</p>
            </div>
          )}

          {tags.length > 0 && (
            <div>
              <p className="text-sm font-medium text-gray-700 mb-2">Tags</p>
              <div className="flex flex-wrap gap-1">
                {tags.map((tag) => (
                  <Badge key={tag} variant="outline">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Reminder Form */}
      {showReminderForm && (
        <Card className="border-blue-200 bg-blue-50">
          <CardHeader>
            <CardTitle className="text-lg">Set Reminder</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSetReminder} className="space-y-4">
              <div>
                <Label>What to remember</Label>
                <Input
                  required
                  placeholder="Follow up about their new job"
                  value={reminderForm.title}
                  onChange={(e) => setReminderForm({ ...reminderForm, title: e.target.value })}
                />
              </div>
              <div>
                <Label>When</Label>
                <Input
                  type="datetime-local"
                  required
                  value={reminderForm.remind_at}
                  onChange={(e) => setReminderForm({ ...reminderForm, remind_at: e.target.value })}
                />
              </div>
              <div>
                <Label>Notes (optional)</Label>
                <Textarea
                  placeholder="Additional context..."
                  value={reminderForm.notes}
                  onChange={(e) => setReminderForm({ ...reminderForm, notes: e.target.value })}
                  rows={2}
                />
              </div>
              <div className="flex gap-2">
                <Button type="submit">Set Reminder</Button>
                <Button type="button" variant="outline" onClick={() => setShowReminderForm(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Relationship Health */}
      <Card>
        <CardHeader>
          <CardTitle>Relationship Health</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-sm font-medium">{getHealthBadge(health)}</span>
              <span className="text-2xl font-bold">{health}%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-3">
              <div
                className={`h-3 rounded-full ${
                  health >= 75 ? 'bg-green-500' : health >= 50 ? 'bg-yellow-500' : 'bg-red-500'
                }`}
                style={{ width: `${health}%` }}
              />
            </div>
            <p className="text-sm text-gray-600">
              Last contact: {formatRelativeDate(contact.last_contacted)}
            </p>
            <p className="text-xs text-gray-500">
              Target frequency: Every {contact.contact_frequency} days
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Gift Ideas */}
      {giftIdeas.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>🎁 Gift Ideas</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc list-inside space-y-1">
              {giftIdeas.map((idea, i) => (
                <li key={i} className="text-gray-700">{idea}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Notes */}
      {contact.notes && (
        <Card>
          <CardHeader>
            <CardTitle>Notes</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-gray-700 whitespace-pre-wrap">{contact.notes}</p>
          </CardContent>
        </Card>
      )}

      {/* Interactions */}
      <Card>
        <CardHeader>
          <div className="flex justify-between items-center">
            <CardTitle>Interactions</CardTitle>
            <Button onClick={() => setShowLogForm(!showLogForm)}>
              Log Interaction
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {showLogForm && (
            <form onSubmit={handleLogInteraction} className="space-y-4 mb-6 p-4 border rounded-lg bg-gray-50">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Type</Label>
                  <select
                    className="w-full h-9 rounded-md border border-input bg-white px-3 py-1 text-sm"
                    value={interactionForm.type}
                    onChange={(e) => setInteractionForm({ ...interactionForm, type: e.target.value })}
                  >
                    <option value="call">Call</option>
                    <option value="message">Message</option>
                    <option value="meetup">Meetup</option>
                    <option value="email">Email</option>
                  </select>
                </div>
                <div>
                  <Label>Date</Label>
                  <Input
                    type="date"
                    value={interactionForm.date}
                    onChange={(e) => setInteractionForm({ ...interactionForm, date: e.target.value })}
                  />
                </div>
              </div>
              <div>
                <Label>Summary</Label>
                <Input
                  placeholder="Quick summary..."
                  value={interactionForm.summary}
                  onChange={(e) => setInteractionForm({ ...interactionForm, summary: e.target.value })}
                />
              </div>
              <div>
                <Label>Notes (optional)</Label>
                <Textarea
                  placeholder="Additional details..."
                  value={interactionForm.notes}
                  onChange={(e) => setInteractionForm({ ...interactionForm, notes: e.target.value })}
                  rows={3}
                />
              </div>
              <div className="flex gap-2">
                <Button type="submit">Save</Button>
                <Button type="button" variant="outline" onClick={() => setShowLogForm(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}

          <div className="space-y-4">
            {interactions.length === 0 ? (
              <p className="text-gray-500 text-center py-8">No interactions logged yet</p>
            ) : (
              interactions.map((interaction) => (
                <div key={interaction.id} className="border-l-2 border-gray-300 pl-4 py-2">
                  <div className="flex items-center gap-2 mb-1">
                    {interaction.type === 'call' && <Phone className="w-4 h-4 text-blue-600" />}
                    {interaction.type === 'message' && <MessageSquare className="w-4 h-4 text-green-600" />}
                    {interaction.type === 'meetup' && <Coffee className="w-4 h-4 text-orange-600" />}
                    {interaction.type === 'email' && <Mail className="w-4 h-4 text-purple-600" />}
                    <span className="font-medium capitalize">{interaction.type}</span>
                    <span className="text-sm text-gray-500">• {formatDate(interaction.date)}</span>
                  </div>
                  {interaction.summary && (
                    <p className="text-gray-700">{interaction.summary}</p>
                  )}
                  {interaction.notes && (
                    <p className="text-sm text-gray-600 mt-1">{interaction.notes}</p>
                  )}
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
