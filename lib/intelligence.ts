import { differenceInDays, parseISO } from 'date-fns';
import { calculateDaysUntilBirthday } from './birthdays.ts';
import type {
  Contact,
  IntegrationConnection,
  Interaction,
  RelationshipFact,
  Reminder,
  SyncJob,
} from './db.ts';
import { parseCustomFields, parseGiftIdeas, parseTags } from './utils.ts';

export type SmartListEntry = {
  id: number;
  name: string;
  reason: string;
  score: number;
  subtitle?: string;
};

export type SmartList = {
  id: string;
  title: string;
  description: string;
  tone: 'warm' | 'focus' | 'info';
  entries: SmartListEntry[];
};

export type DailyFeedItem = {
  id: string;
  type: 'reminder' | 'birthday' | 'relationship' | 'integration' | 'signal';
  title: string;
  detail: string;
  href: string;
  priority: 'high' | 'medium' | 'low';
  date?: string;
};

export type TimelineItem = {
  id: string;
  kind: 'interaction' | 'reminder' | 'fact' | 'signal';
  title: string;
  summary: string;
  date: string;
  tone: 'warm' | 'info' | 'urgent';
};

export type RelationshipBrief = {
  headline: string;
  summary: string;
  nextStep: string;
  talkingPoints: string[];
  suggestedOutreach: string[];
  momentum: 'strong' | 'steady' | 'stale';
};

type DerivedFact = {
  id: string;
  category: string;
  label: string;
  value: string;
  source: string;
  date: string;
};

type ContactSignals = {
  contact: Contact;
  tags: string[];
  company: string | null;
  location: string | null;
  linkedInImportedAt: string | null;
  daysSinceLastContact: number | null;
  overdueDays: number;
  interactionsCount: number;
  latestInteraction: Interaction | null;
  openReminders: Reminder[];
  birthdayDaysUntil: number | null;
};

function getLinkedInMeta(contact: Contact): Record<string, unknown> | null {
  const customFields = parseCustomFields(contact.custom_fields);
  const linkedIn = customFields.linkedin;
  if (!linkedIn || typeof linkedIn !== 'object') {
    return null;
  }
  return linkedIn as Record<string, unknown>;
}

function getCompany(contact: Contact): string | null {
  const linkedIn = getLinkedInMeta(contact);
  if (linkedIn && typeof linkedIn.company === 'string' && linkedIn.company.trim()) {
    return linkedIn.company.trim();
  }
  return null;
}

function getLocation(contact: Contact): string | null {
  const linkedIn = getLinkedInMeta(contact);
  if (linkedIn && typeof linkedIn.location === 'string' && linkedIn.location.trim()) {
    return linkedIn.location.trim();
  }
  return null;
}

function getImportedAt(contact: Contact): string | null {
  const linkedIn = getLinkedInMeta(contact);
  if (linkedIn && typeof linkedIn.imported_at === 'string' && linkedIn.imported_at.trim()) {
    return linkedIn.imported_at.trim();
  }
  return null;
}

function formatDaysAgo(days: number | null): string {
  if (days === null) return 'No logged contact yet';
  if (days === 0) return 'Connected today';
  if (days === 1) return 'Last touched yesterday';
  if (days < 7) return `Last touched ${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `Last touched ${weeks}w ago`;
  const months = Math.floor(days / 30);
  return `Last touched ${months}mo ago`;
}

function toTime(value: string | null): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function sortByDateDescending<T extends { date: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => toTime(b.date) - toTime(a.date));
}

function buildDerivedFacts(contact: Contact): DerivedFact[] {
  const facts: DerivedFact[] = [];
  const createdAt = contact.updated_at || contact.created_at;

  if (contact.how_we_met) {
    facts.push({
      id: `how-we-met-${contact.id}`,
      category: 'relationship',
      label: 'How you met',
      value: contact.how_we_met,
      source: 'contact',
      date: createdAt,
    });
  }

  const giftIdeas = parseGiftIdeas(contact.gift_ideas);
  giftIdeas.slice(0, 2).forEach((idea, index) => {
    facts.push({
      id: `gift-${contact.id}-${index}`,
      category: 'gift',
      label: 'Gift idea',
      value: idea,
      source: 'contact',
      date: createdAt,
    });
  });

  const company = getCompany(contact);
  if (company) {
    facts.push({
      id: `company-${contact.id}`,
      category: 'work',
      label: 'Company',
      value: company,
      source: 'linkedin',
      date: getImportedAt(contact) || createdAt,
    });
  }

  const location = getLocation(contact);
  if (location) {
    facts.push({
      id: `location-${contact.id}`,
      category: 'life',
      label: 'Location',
      value: location,
      source: 'linkedin',
      date: getImportedAt(contact) || createdAt,
    });
  }

  return facts;
}

function buildContactSignals(
  contact: Contact,
  interactions: Interaction[],
  reminders: Reminder[],
  now: Date
): ContactSignals {
  const tags = parseTags(contact.tags);
  const contactInteractions = sortByDateDescending(
    interactions.filter((interaction) => interaction.contact_id === contact.id).map((interaction) => ({
      ...interaction,
      date: interaction.date,
    }))
  );
  const openReminders = reminders
    .filter((reminder) => reminder.contact_id === contact.id && !reminder.completed_at)
    .sort((a, b) => toTime(a.remind_at) - toTime(b.remind_at));

  const daysSinceLastContact = contact.last_contacted
    ? differenceInDays(now, parseISO(contact.last_contacted))
    : null;
  const overdueDays = daysSinceLastContact === null
    ? 0
    : Math.max(0, daysSinceLastContact - (contact.contact_frequency || 14));
  const birthdayDaysUntil = contact.birthday
    ? calculateDaysUntilBirthday(now, contact.birthday)
    : null;

  return {
    contact,
    tags,
    company: getCompany(contact),
    location: getLocation(contact),
    linkedInImportedAt: getImportedAt(contact),
    daysSinceLastContact,
    overdueDays,
    interactionsCount: contactInteractions.length,
    latestInteraction: contactInteractions[0] ?? null,
    openReminders,
    birthdayDaysUntil,
  };
}

export function buildSmartLists(
  contacts: Contact[],
  interactions: Interaction[],
  reminders: Reminder[],
  now = new Date()
): SmartList[] {
  const signals = contacts.map((contact) => buildContactSignals(contact, interactions, reminders, now));

  const overdueFriends = signals
    .filter((signal) => signal.tags.includes('friend') && signal.overdueDays > 0)
    .sort((a, b) => b.overdueDays - a.overdueDays)
    .slice(0, 6)
    .map((signal) => ({
      id: signal.contact.id,
      name: signal.contact.name,
      reason: `${signal.overdueDays}d overdue · ${formatDaysAgo(signal.daysSinceLastContact)}`,
      score: signal.overdueDays,
      subtitle: signal.location || undefined,
    }));

  const warmProfessionalLeads = signals
    .filter((signal) =>
      signal.tags.includes('work') ||
      signal.tags.includes('linkedin') ||
      Boolean(signal.company)
    )
    .sort((a, b) => {
      const aScore = (a.latestInteraction ? 30 : 0) + (a.overdueDays === 0 ? 20 : 0) + (a.company ? 10 : 0);
      const bScore = (b.latestInteraction ? 30 : 0) + (b.overdueDays === 0 ? 20 : 0) + (b.company ? 10 : 0);
      return bScore - aScore;
    })
    .slice(0, 6)
    .map((signal) => ({
      id: signal.contact.id,
      name: signal.contact.name,
      reason: signal.company ? `${signal.company} · ${formatDaysAgo(signal.daysSinceLastContact)}` : formatDaysAgo(signal.daysSinceLastContact),
      score: Math.max(0, 100 - signal.overdueDays),
      subtitle: signal.location || undefined,
    }));

  const birthdaysSoon = signals
    .filter((signal) => signal.birthdayDaysUntil !== null && signal.birthdayDaysUntil >= 0 && signal.birthdayDaysUntil <= 30)
    .sort((a, b) => (a.birthdayDaysUntil ?? 999) - (b.birthdayDaysUntil ?? 999))
    .slice(0, 6)
    .map((signal) => ({
      id: signal.contact.id,
      name: signal.contact.name,
      reason: signal.birthdayDaysUntil === 0
        ? 'Birthday today'
        : signal.birthdayDaysUntil === 1
          ? 'Birthday tomorrow'
          : `Birthday in ${signal.birthdayDaysUntil} days`,
      score: 100 - (signal.birthdayDaysUntil ?? 0),
      subtitle: signal.company || undefined,
    }));

  const peopleWithContext = signals
    .filter((signal) => Boolean(signal.company || signal.location || signal.tags.length > 0))
    .sort((a, b) => {
      const aScore = Number(Boolean(a.company)) + Number(Boolean(a.location)) + a.tags.length;
      const bScore = Number(Boolean(b.company)) + Number(Boolean(b.location)) + b.tags.length;
      return bScore - aScore;
    })
    .slice(0, 6)
    .map((signal) => ({
      id: signal.contact.id,
      name: signal.contact.name,
      reason: [signal.company, signal.location].filter(Boolean).join(' · ') || signal.tags.slice(0, 2).join(' · '),
      score: signal.tags.length + (signal.company ? 10 : 0) + (signal.location ? 5 : 0),
      subtitle: signal.tags.slice(0, 2).join(', ') || undefined,
    }));

  const dormantStrongTies = signals
    .filter((signal) => signal.interactionsCount >= 2 && signal.overdueDays > 0)
    .sort((a, b) => {
      const aScore = a.overdueDays * 2 + a.interactionsCount;
      const bScore = b.overdueDays * 2 + b.interactionsCount;
      return bScore - aScore;
    })
    .slice(0, 6)
    .map((signal) => ({
      id: signal.contact.id,
      name: signal.contact.name,
      reason: `${signal.interactionsCount} past interactions · ${signal.overdueDays}d overdue`,
      score: signal.overdueDays * 2 + signal.interactionsCount,
      subtitle: signal.company || undefined,
    }));

  return [
    {
      id: 'overdue-friends',
      title: 'Overdue friends',
      description: 'Strong personal relationships that need a nudge.',
      tone: 'focus',
      entries: overdueFriends,
    },
    {
      id: 'warm-professional-leads',
      title: 'Warm professional leads',
      description: 'People with current momentum worth keeping warm.',
      tone: 'warm',
      entries: warmProfessionalLeads,
    },
    {
      id: 'birthdays-soon',
      title: 'Birthdays soon',
      description: 'Upcoming moments that deserve fast follow-up.',
      tone: 'info',
      entries: birthdaysSoon,
    },
    {
      id: 'people-with-context',
      title: 'People with context',
      description: 'Contacts enriched with company, location, or topic signals.',
      tone: 'info',
      entries: peopleWithContext,
    },
    {
      id: 'dormant-strong-ties',
      title: 'Dormant strong ties',
      description: 'High-context relationships that are starting to cool off.',
      tone: 'focus',
      entries: dormantStrongTies,
    },
  ];
}

export function buildDailyFeed(
  contacts: Contact[],
  interactions: Interaction[],
  reminders: Reminder[],
  integrations: IntegrationConnection[],
  now = new Date()
): DailyFeedItem[] {
  const signals = contacts.map((contact) => buildContactSignals(contact, interactions, reminders, now));
  const items: DailyFeedItem[] = [];

  reminders
    .filter((reminder) => !reminder.completed_at)
    .sort((a, b) => toTime(a.remind_at) - toTime(b.remind_at))
    .slice(0, 4)
    .forEach((reminder) => {
      const contact = contacts.find((entry) => entry.id === reminder.contact_id);
      items.push({
        id: `reminder-${reminder.id}`,
        type: 'reminder',
        title: reminder.title,
        detail: contact ? `${contact.name} · due ${new Date(reminder.remind_at).toLocaleString()}` : `Due ${new Date(reminder.remind_at).toLocaleString()}`,
        href: contact ? `/contacts/${contact.id}` : '/reminders',
        priority: toTime(reminder.remind_at) < now.getTime() ? 'high' : 'medium',
        date: reminder.remind_at,
      });
    });

  signals
    .filter((signal) => signal.birthdayDaysUntil !== null && signal.birthdayDaysUntil >= 0 && signal.birthdayDaysUntil <= 7)
    .sort((a, b) => (a.birthdayDaysUntil ?? 99) - (b.birthdayDaysUntil ?? 99))
    .slice(0, 3)
    .forEach((signal) => {
      items.push({
        id: `birthday-${signal.contact.id}`,
        type: 'birthday',
        title: `${signal.contact.name}'s birthday`,
        detail: signal.birthdayDaysUntil === 0 ? 'Happening today' : `In ${signal.birthdayDaysUntil} day${signal.birthdayDaysUntil === 1 ? '' : 's'}`,
        href: `/contacts/${signal.contact.id}`,
        priority: (signal.birthdayDaysUntil ?? 99) <= 1 ? 'high' : 'medium',
        date: signal.contact.birthday || undefined,
      });
    });

  signals
    .filter((signal) => signal.overdueDays > 0)
    .sort((a, b) => b.overdueDays - a.overdueDays)
    .slice(0, 3)
    .forEach((signal) => {
      items.push({
        id: `overdue-${signal.contact.id}`,
        type: 'relationship',
        title: `Reconnect with ${signal.contact.name}`,
        detail: `${signal.overdueDays}d overdue · ${signal.company || signal.location || 'Relationship health is cooling off'}`,
        href: `/contacts/${signal.contact.id}`,
        priority: signal.overdueDays > signal.contact.contact_frequency ? 'high' : 'medium',
        date: signal.contact.last_contacted || signal.contact.updated_at,
      });
    });

  integrations
    .filter((integration) => integration.status !== 'connected')
    .slice(0, 2)
    .forEach((integration) => {
      items.push({
        id: `integration-${integration.provider}`,
        type: 'integration',
        title: `${integration.label} needs setup`,
        detail: integration.status === 'attention'
          ? 'Connection path exists but needs finishing touches.'
          : 'Connect this source to automate more of your relationship upkeep.',
        href: '/integrations',
        priority: integration.status === 'attention' ? 'medium' : 'low',
        date: integration.updated_at,
      });
    });

  return items
    .sort((a, b) => {
      const priorityWeight = { high: 3, medium: 2, low: 1 };
      return priorityWeight[b.priority] - priorityWeight[a.priority] || toTime(b.date || null) - toTime(a.date || null);
    })
    .slice(0, 8);
}

export function buildTimeline(
  contact: Contact,
  interactions: Interaction[],
  reminders: Reminder[],
  storedFacts: RelationshipFact[]
): TimelineItem[] {
  const derivedFacts = buildDerivedFacts(contact);
  const items: TimelineItem[] = [];

  interactions
    .filter((interaction) => interaction.contact_id === contact.id)
    .forEach((interaction) => {
      items.push({
        id: `interaction-${interaction.id}`,
        kind: 'interaction',
        title: interaction.summary || `${interaction.type} logged`,
        summary: interaction.notes || `Interaction type: ${interaction.type}`,
        date: interaction.date,
        tone: 'warm',
      });
    });

  reminders
    .filter((reminder) => reminder.contact_id === contact.id)
    .forEach((reminder) => {
      items.push({
        id: `reminder-${reminder.id}`,
        kind: 'reminder',
        title: reminder.title,
        summary: reminder.completed_at ? 'Reminder completed' : (reminder.notes || 'Reminder scheduled'),
        date: reminder.completed_at || reminder.remind_at,
        tone: reminder.completed_at ? 'info' : 'urgent',
      });
    });

  storedFacts.forEach((fact) => {
    items.push({
      id: `fact-${fact.id}`,
      kind: 'fact',
      title: fact.label,
      summary: fact.value || `Source: ${fact.source}`,
      date: fact.last_verified_at || fact.created_at,
      tone: 'info',
    });
  });

  derivedFacts.forEach((fact) => {
    items.push({
      id: fact.id,
      kind: 'signal',
      title: fact.label,
      summary: fact.value,
      date: fact.date,
      tone: 'info',
    });
  });

  const importedAt = getImportedAt(contact);
  if (importedAt) {
    items.push({
      id: `signal-linkedin-import-${contact.id}`,
      kind: 'signal',
      title: 'LinkedIn profile captured',
      summary: 'Imported into Bonds via the browser extension.',
      date: importedAt,
      tone: 'info',
    });
  }

  return items
    .filter((item) => item.date)
    .sort((a, b) => toTime(b.date) - toTime(a.date));
}

export function buildRelationshipBrief(
  contact: Contact,
  interactions: Interaction[],
  reminders: Reminder[],
  storedFacts: RelationshipFact[]
): RelationshipBrief {
  const now = new Date();
  const signal = buildContactSignals(contact, interactions, reminders, now);
  const facts = [...storedFacts.slice(0, 3).map((fact) => `${fact.label}: ${fact.value ?? fact.source}`)];
  const derivedFacts = buildDerivedFacts(contact).slice(0, 3).map((fact) => `${fact.label}: ${fact.value}`);
  const talkingPoints = Array.from(new Set([...facts, ...derivedFacts])).slice(0, 4);

  const latestInteraction = signal.latestInteraction;
  const latestReminder = signal.openReminders[0];

  let momentum: RelationshipBrief['momentum'] = 'steady';
  if (signal.overdueDays > signal.contact.contact_frequency || signal.daysSinceLastContact === null) {
    momentum = 'stale';
  } else if (signal.overdueDays === 0 && signal.interactionsCount >= 2) {
    momentum = 'strong';
  }

  const summaryParts = [
    signal.company ? `${contact.name} is currently at ${signal.company}.` : null,
    signal.location ? `Location on file: ${signal.location}.` : null,
    latestInteraction?.summary ? `Last interaction: ${latestInteraction.summary}.` : null,
    latestReminder ? `Open reminder: ${latestReminder.title}.` : null,
  ].filter((part): part is string => Boolean(part));

  let nextStep = 'Log a fresh note or send a quick check-in.';
  if (latestReminder) {
    nextStep = `Handle the reminder "${latestReminder.title}" next.`;
  } else if (signal.overdueDays > 0) {
    nextStep = `Reach out this week. The relationship is ${signal.overdueDays}d past the target cadence.`;
  } else if (signal.latestInteraction?.summary) {
    nextStep = `Follow up on "${signal.latestInteraction.summary}" while it is still fresh.`;
  }

  const suggestedOutreach = [
    signal.company ? `Ask how things are going at ${signal.company}.` : null,
    signal.location ? `Reference something happening in ${signal.location}.` : null,
    latestInteraction?.summary ? `Pick up the thread from "${latestInteraction.summary}".` : null,
    parseGiftIdeas(contact.gift_ideas)[0] ? `Save the gift idea "${parseGiftIdeas(contact.gift_ideas)[0]}" for the next relevant moment.` : null,
    signal.tags[0] ? `Use the ${signal.tags[0]} context to make the outreach feel personal.` : null,
  ].filter((entry): entry is string => Boolean(entry)).slice(0, 3);

  return {
    headline:
      momentum === 'strong'
        ? 'Healthy relationship momentum'
        : momentum === 'steady'
          ? 'Momentum is stable but worth maintaining'
          : 'This relationship needs attention',
    summary: summaryParts.join(' ') || `${contact.name} does not have much structured context yet. Add a note or import more detail to improve future suggestions.`,
    nextStep,
    talkingPoints,
    suggestedOutreach,
    momentum,
  };
}

export function buildIntegrationSnapshots(
  integrations: IntegrationConnection[],
  syncJobs: SyncJob[]
): Array<IntegrationConnection & { latest_job: SyncJob | null }> {
  return integrations.map((integration) => {
    const latestJob = syncJobs
      .filter((job) => job.provider === integration.provider)
      .sort((a, b) => toTime(b.started_at) - toTime(a.started_at))[0] ?? null;

    return {
      ...integration,
      latest_job: latestJob,
    };
  });
}

export function buildIntelligenceOverview(
  contacts: Contact[],
  interactions: Interaction[],
  reminders: Reminder[],
  integrations: IntegrationConnection[],
  syncJobs: SyncJob[],
  now = new Date()
) {
  const smartLists = buildSmartLists(contacts, interactions, reminders, now);
  const feed = buildDailyFeed(contacts, interactions, reminders, integrations, now);
  const connectedIntegrations = integrations.filter((integration) => integration.status === 'connected').length;
  const overdueCount = contacts.filter((contact) => {
    if (!contact.last_contacted) return false;
    return differenceInDays(now, parseISO(contact.last_contacted)) > (contact.contact_frequency || 14);
  }).length;
  const strongRelationships = contacts.filter((contact) => {
    if (!contact.last_contacted) return false;
    return differenceInDays(now, parseISO(contact.last_contacted)) <= Math.max(7, Math.floor((contact.contact_frequency || 14) / 2));
  }).length;
  const openReminderCount = reminders.filter((reminder) => !reminder.completed_at).length;

  return {
    stats: {
      totalContacts: contacts.length,
      overdueCount,
      openReminderCount,
      connectedIntegrations,
      strongRelationships,
    },
    smartLists,
    feed,
    integrations: buildIntegrationSnapshots(integrations, syncJobs),
  };
}
