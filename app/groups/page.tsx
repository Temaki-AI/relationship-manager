'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { FolderOpen, Plus, ChevronDown, ChevronRight, Edit, Trash2, X, Save, UserPlus } from 'lucide-react';
import type { Contact, ContactGroup } from '@/lib/db';
import { Avatar } from '@/components/ui/avatar';

const COLOR_OPTIONS = [
  { name: 'rose', bg: 'bg-rose-500' },
  { name: 'blue', bg: 'bg-blue-500' },
  { name: 'emerald', bg: 'bg-emerald-500' },
  { name: 'amber', bg: 'bg-amber-500' },
  { name: 'purple', bg: 'bg-purple-500' },
  { name: 'indigo', bg: 'bg-indigo-500' },
  { name: 'cyan', bg: 'bg-cyan-500' },
  { name: 'pink', bg: 'bg-pink-500' },
];

function getColorClass(color: string | null): string {
  const found = COLOR_OPTIONS.find(c => c.name === color);
  return found ? found.bg : 'bg-muted-foreground';
}

type GroupWithCount = ContactGroup & { member_count: number };

function SkeletonGroups() {
  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div className="skeleton h-9 w-40" />
        <div className="skeleton h-9 w-36" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1, 2, 3].map(i => (
          <div key={i} className="skeleton h-24 rounded-xl" />
        ))}
      </div>
    </div>
  );
}

export default function GroupsPage() {
  const [groups, setGroups] = useState<GroupWithCount[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newGroup, setNewGroup] = useState({ name: '', color: 'rose' });
  const [expandedGroupId, setExpandedGroupId] = useState<number | null>(null);
  const [groupMembers, setGroupMembers] = useState<Record<number, Contact[]>>({});
  const [editingGroupId, setEditingGroupId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({ name: '', color: '' });

  useEffect(() => {
    async function fetchData() {
      try {
        const [groupsRes, contactsRes] = await Promise.all([
          fetch('/api/groups'),
          fetch('/api/contacts'),
        ]);
        const groupsData = await groupsRes.json();
        const contactsData = await contactsRes.json();
        setGroups(groupsData.groups);
        setContacts(contactsData.contacts);
      } catch (error) {
        console.error('Failed to fetch groups:', error);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  async function fetchGroupMembers(groupId: number) {
    try {
      const res = await fetch(`/api/groups/${groupId}`);
      const data = await res.json();
      setGroupMembers(prev => ({ ...prev, [groupId]: data.members }));
    } catch (error) {
      console.error('Failed to fetch group members:', error);
    }
  }

  async function refreshGroups() {
    const res = await fetch('/api/groups');
    const data = await res.json();
    setGroups(data.groups);
  }

  async function handleCreateGroup(e: React.FormEvent) {
    e.preventDefault();
    try {
      await fetch('/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newGroup),
      });
      setNewGroup({ name: '', color: 'rose' });
      setShowCreateForm(false);
      await refreshGroups();
    } catch (error) {
      console.error('Failed to create group:', error);
    }
  }

  async function handleEditGroup(groupId: number) {
    try {
      await fetch(`/api/groups/${groupId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editForm),
      });
      setEditingGroupId(null);
      await refreshGroups();
    } catch (error) {
      console.error('Failed to update group:', error);
    }
  }

  async function handleDeleteGroup(groupId: number) {
    if (!confirm('Delete this group? Members will not be deleted.')) return;
    try {
      await fetch(`/api/groups/${groupId}`, { method: 'DELETE' });
      if (expandedGroupId === groupId) setExpandedGroupId(null);
      await refreshGroups();
    } catch (error) {
      console.error('Failed to delete group:', error);
    }
  }

  async function handleAddMember(groupId: number, contactId: number) {
    try {
      await fetch(`/api/groups/${groupId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: contactId }),
      });
      await fetchGroupMembers(groupId);
      await refreshGroups();
    } catch (error) {
      console.error('Failed to add member:', error);
    }
  }

  async function handleRemoveMember(groupId: number, contactId: number) {
    try {
      await fetch(`/api/groups/${groupId}/members?contact_id=${contactId}`, {
        method: 'DELETE',
      });
      await fetchGroupMembers(groupId);
      await refreshGroups();
    } catch (error) {
      console.error('Failed to remove member:', error);
    }
  }

  function toggleExpand(groupId: number) {
    if (expandedGroupId === groupId) {
      setExpandedGroupId(null);
    } else {
      setExpandedGroupId(groupId);
      if (!groupMembers[groupId]) {
        fetchGroupMembers(groupId);
      }
    }
  }

  function startEdit(group: GroupWithCount) {
    setEditingGroupId(group.id);
    setEditForm({ name: group.name, color: group.color || 'rose' });
  }

  if (loading) return <SkeletonGroups />;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 animate-fade-in">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold">Groups</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {groups.length} {groups.length === 1 ? 'group' : 'groups'}
          </p>
        </div>
        <Button size="sm" onClick={() => setShowCreateForm(!showCreateForm)}>
          <Plus className="w-3.5 h-3.5 mr-1.5" />
          Create group
        </Button>
      </div>

      {/* Create Form */}
      {showCreateForm && (
        <Card className="animate-slide-down border-primary/20 bg-primary/5">
          <CardContent className="pt-5 pb-4">
            <form onSubmit={handleCreateGroup} className="space-y-3">
              <div className="flex items-center gap-2 mb-1">
                <FolderOpen className="w-4 h-4 text-primary" />
                <span className="font-medium text-sm">New group</span>
              </div>
              <Input
                required
                placeholder="Group name..."
                value={newGroup.name}
                onChange={(e) => setNewGroup({ ...newGroup, name: e.target.value })}
                className="bg-white"
              />
              <div>
                <span className="text-xs text-muted-foreground">Color</span>
                <div className="flex gap-2 mt-1.5">
                  {COLOR_OPTIONS.map((color) => (
                    <button
                      key={color.name}
                      type="button"
                      onClick={() => setNewGroup({ ...newGroup, color: color.name })}
                      className={`w-7 h-7 rounded-full ${color.bg} transition-all ${
                        newGroup.color === color.name
                          ? 'ring-2 ring-offset-2 ring-primary scale-110'
                          : 'hover:scale-105'
                      }`}
                    />
                  ))}
                </div>
              </div>
              <div className="flex gap-2">
                <Button type="submit" size="sm">Create</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setShowCreateForm(false)}>Cancel</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Groups Grid */}
      {groups.length > 0 ? (
        <div className="space-y-3 stagger-children">
          {groups.map((group) => {
            const isExpanded = expandedGroupId === group.id;
            const isEditing = editingGroupId === group.id;
            const members = groupMembers[group.id] || [];
            const availableContacts = contacts.filter(
              c => !members.some(m => m.id === c.id)
            );

            return (
              <Card key={group.id} className="border-0 shadow-sm">
                <CardContent className="pt-4 pb-4">
                  {/* Group Header */}
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => toggleExpand(group.id)}
                      className="flex items-center gap-3 flex-1 min-w-0 text-left"
                    >
                      <div className={`w-4 h-4 rounded-full flex-shrink-0 ${getColorClass(group.color)}`} />
                      {isEditing ? (
                        <div className="flex-1 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                          <Input
                            value={editForm.name}
                            onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                            className="h-8 text-sm"
                          />
                          <div className="flex gap-1">
                            {COLOR_OPTIONS.map((color) => (
                              <button
                                key={color.name}
                                type="button"
                                onClick={(e) => { e.stopPropagation(); setEditForm({ ...editForm, color: color.name }); }}
                                className={`w-5 h-5 rounded-full ${color.bg} transition-all ${
                                  editForm.color === color.name ? 'ring-2 ring-offset-1 ring-primary' : ''
                                }`}
                              />
                            ))}
                          </div>
                          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={(e) => { e.stopPropagation(); handleEditGroup(group.id); }}>
                            <Save className="w-3.5 h-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={(e) => { e.stopPropagation(); setEditingGroupId(null); }}>
                            <X className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      ) : (
                        <>
                          <span className="font-semibold text-sm truncate">{group.name}</span>
                          <Badge variant="secondary" className="text-xs font-normal flex-shrink-0">
                            {group.member_count} {group.member_count === 1 ? 'member' : 'members'}
                          </Badge>
                        </>
                      )}
                    </button>
                    {!isEditing && (
                      <div className="flex gap-1 flex-shrink-0">
                        <button onClick={() => startEdit(group)} className="p-1.5 rounded-lg hover:bg-muted transition-colors">
                          <Edit className="w-3.5 h-3.5 text-muted-foreground" />
                        </button>
                        <button onClick={() => handleDeleteGroup(group.id)} className="p-1.5 rounded-lg hover:bg-red-50 transition-colors">
                          <Trash2 className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
                        </button>
                        {isExpanded
                          ? <ChevronDown className="w-4 h-4 text-muted-foreground mt-1" />
                          : <ChevronRight className="w-4 h-4 text-muted-foreground mt-1" />
                        }
                      </div>
                    )}
                  </div>

                  {/* Expanded Members */}
                  {isExpanded && (
                    <div className="mt-4 pt-4 border-t border-border/50 animate-slide-down">
                      {/* Add Member */}
                      {availableContacts.length > 0 && (
                        <div className="flex items-center gap-2 mb-3">
                          <UserPlus className="w-3.5 h-3.5 text-muted-foreground" />
                          <select
                            className="flex-1 h-8 rounded-lg border border-input bg-white px-2 text-sm"
                            value=""
                            onChange={(e) => {
                              if (e.target.value) handleAddMember(group.id, Number(e.target.value));
                            }}
                          >
                            <option value="">Add a contact...</option>
                            {availableContacts.map(c => (
                              <option key={c.id} value={c.id}>{c.name}</option>
                            ))}
                          </select>
                        </div>
                      )}

                      {/* Member List */}
                      {members.length > 0 ? (
                        <div className="space-y-1">
                          {members.map((member) => (
                            <div key={member.id} className="flex items-center gap-3 p-2 rounded-xl hover:bg-muted/50 transition-colors group/member">
                              <Avatar contact={member} size="sm" className="w-8 h-8" />
                              <Link href={`/contacts/${member.id}`} className="flex-1 min-w-0">
                                <p className="text-sm font-medium truncate hover:text-primary transition-colors">{member.name}</p>
                                {member.email && <p className="text-xs text-muted-foreground truncate">{member.email}</p>}
                              </Link>
                              <button
                                onClick={() => handleRemoveMember(group.id, member.id)}
                                className="p-1 rounded hover:bg-red-50 opacity-0 group-hover/member:opacity-100 sm:opacity-0 sm:group-hover/member:opacity-100 transition-opacity"
                              >
                                <X className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground text-center py-4">No members yet</p>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card className="animate-scale-in border-0 shadow-sm">
          <CardContent className="py-16 text-center">
            <div className="text-5xl mb-4">📁</div>
            <h3 className="text-lg font-semibold">No groups yet</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
              Create a group to organize your contacts — Family, Work, Tennis Club, whatever makes sense.
            </p>
            <Button className="mt-4" onClick={() => setShowCreateForm(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Create your first group
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
