import { civilDaysBetween, dateInTimeZone, nextBirthdayOccurrence, normalizeTimeZone } from './civil-date.ts';
import type {
  Contact,
  Interaction,
  RelationshipFact,
  Reminder,
} from './db.ts';
import { DATA_CAPABILITIES } from './data-capabilities.ts';
import { buildFirstSteps } from './first-steps.ts';
import { activeTodaySnoozeIds, type TodaySnooze } from './today-snooze.ts';
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
  type: 'reminder' | 'birthday' | 'relationship' | 'signal';
  title: string;
  detail: string;
  href: string;
  priority: 'high' | 'medium' | 'low';
  date?: string;
  contactId?: number;
  contactName?: string;
  contactEmail?: string | null;
  contactPhone?: string | null;
  lastInteraction?: Pick<IntelligenceInteraction, 'date' | 'type' | 'summary'> | null;
  reminderId?: number;
  reasons?: Array<Pick<DailyFeedItem, 'id' | 'type' | 'title' | 'detail' | 'date' | 'reminderId'>>;
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

export type IntelligenceContact = Pick<
  Contact,
  | 'id'
  | 'name'
  | 'email'
  | 'phone'
  | 'birthday'
  | 'birthday_reminder_days'
  | 'tags'
  | 'custom_fields'
  | 'last_contacted'
  | 'contact_frequency'
  | 'created_at'
  | 'updated_at'
>;

export type IntelligenceInteraction = Pick<
  Interaction,
  'id' | 'contact_id' | 'date' | 'type' | 'summary'
>;

export type IntelligenceReminder = Pick<
  Reminder,
  'id' | 'contact_id' | 'title' | 'remind_at' | 'completed_at'
>;

export type ContactActivitySummary = {
  contactId: number;
  interactionsCount: number;
  latestInteraction: IntelligenceInteraction | null;
  openReminders: IntelligenceReminder[];
};

type ContactSignals = {
  contact: IntelligenceContact;
  tags: string[];
  company: string | null;
  location: string | null;
  linkedInImportedAt: string | null;
  daysSinceLastContact: number | null;
  checkInDue: boolean;
  overdueDays: number;
  interactionsCount: number;
  latestInteraction: IntelligenceInteraction | null;
  openReminders: IntelligenceReminder[];
  birthdayDaysUntil: number | null;
};

function getLinkedInMeta(contact: Pick<Contact, 'custom_fields'>): Record<string, unknown> | null {
  const customFields = parseCustomFields(contact.custom_fields);
  const linkedIn = customFields.linkedin;
  if (!linkedIn || typeof linkedIn !== 'object') {
    return null;
  }
  return linkedIn as Record<string, unknown>;
}

function getCompany(contact: Pick<Contact, 'custom_fields'>): string | null {
  const manual = parseCustomFields(contact.custom_fields).company;
  if (typeof manual === 'string' && manual.trim()) return manual.trim();
  const linkedIn = getLinkedInMeta(contact);
  if (linkedIn && typeof linkedIn.company === 'string' && linkedIn.company.trim()) {
    return linkedIn.company.trim();
  }
  return null;
}

function getLocation(contact: Pick<Contact, 'custom_fields'>): string | null {
  const manual = parseCustomFields(contact.custom_fields).location;
  if (typeof manual === 'string' && manual.trim()) return manual.trim();
  const linkedIn = getLinkedInMeta(contact);
  if (linkedIn && typeof linkedIn.location === 'string' && linkedIn.location.trim()) {
    return linkedIn.location.trim();
  }
  return null;
}

function getImportedAt(contact: Pick<Contact, 'custom_fields'>): string | null {
  const linkedIn = getLinkedInMeta(contact);
  if (linkedIn && typeof linkedIn.imported_at === 'string' && linkedIn.imported_at.trim()) {
    return linkedIn.imported_at.trim();
  }
  return null;
}

function formatDaysAgo(days: number | null): string {
  if (days === null) return 'No logged contact yet';
  if (days === 0) return 'Connected today';
  if (days === 1) return 'Last in touch yesterday';
  if (days < 7) return `Last in touch ${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `Last in touch ${weeks}w ago`;
  const months = Math.floor(days / 30);
  return `Last in touch ${months}mo ago`;
}

function checkInTiming(daysPast: number): string {
  return daysPast === 0 ? 'Check-in day' : `${daysPast} ${daysPast === 1 ? 'day' : 'days'} past your check-in preference`;
}

function toTime(value: string | null): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
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

function createEmptyActivity(contactId: number): ContactActivitySummary {
  return {
    contactId,
    interactionsCount: 0,
    latestInteraction: null,
    openReminders: [],
  };
}

function isLaterInteraction(
  candidate: IntelligenceInteraction,
  current: IntelligenceInteraction | null
): boolean {
  if (!current) return true;
  const dateDifference = toTime(candidate.date) - toTime(current.date);
  return dateDifference > 0 || (dateDifference === 0 && candidate.id > current.id);
}

export function prepareContactActivity(
  interactions: readonly IntelligenceInteraction[],
  reminders: readonly IntelligenceReminder[]
): Map<number, ContactActivitySummary> {
  const activity = new Map<number, ContactActivitySummary>();
  const getActivity = (contactId: number) => {
    let summary = activity.get(contactId);
    if (!summary) {
      summary = createEmptyActivity(contactId);
      activity.set(contactId, summary);
    }
    return summary;
  };

  for (const interaction of interactions) {
    const summary = getActivity(interaction.contact_id);
    summary.interactionsCount += 1;
    if (isLaterInteraction(interaction, summary.latestInteraction)) {
      summary.latestInteraction = interaction;
    }
  }

  for (const reminder of reminders) {
    if (!reminder.completed_at) {
      getActivity(reminder.contact_id).openReminders.push(reminder);
    }
  }

  for (const summary of activity.values()) {
    summary.openReminders.sort((a, b) => {
      const dateDifference = toTime(a.remind_at) - toTime(b.remind_at);
      return dateDifference || a.id - b.id;
    });
  }

  return activity;
}

function buildContactSignals(
  contact: IntelligenceContact,
  activity: ContactActivitySummary,
  now: Date,
  timeZone = 'UTC',
  snoozedIds: ReadonlySet<string> = new Set()
): ContactSignals {
  const tags = parseTags(contact.tags);
  const daysSinceLastContact = contact.last_contacted
    ? Math.max(0, civilDaysBetween(contact.last_contacted, dateInTimeZone(now, timeZone)!))
    : null;
  const cadence = Number.isInteger(contact.contact_frequency) && contact.contact_frequency > 0 ? contact.contact_frequency : 14;
  const checkInDue = daysSinceLastContact !== null && daysSinceLastContact >= cadence
    && !snoozedIds.has(`overdue-${contact.id}`);
  const overdueDays = checkInDue ? daysSinceLastContact - cadence : 0;
  const birthdayDaysUntil = contact.birthday
    ? nextBirthdayOccurrence(contact.birthday, dateInTimeZone(now, timeZone)!)?.daysUntil ?? null
    : null;

  return {
    contact,
    tags,
    company: getCompany(contact),
    location: getLocation(contact),
    linkedInImportedAt: getImportedAt(contact),
    daysSinceLastContact,
    checkInDue,
    overdueDays,
    interactionsCount: activity.interactionsCount,
    latestInteraction: activity.latestInteraction,
    openReminders: activity.openReminders,
    birthdayDaysUntil,
  };
}

function buildContactSignalSet(
  contacts: readonly IntelligenceContact[],
  activity: ReadonlyMap<number, ContactActivitySummary>,
  now: Date,
  timeZone = 'UTC',
  snoozedIds: ReadonlySet<string> = new Set()
): ContactSignals[] {
  return contacts.map((contact) => buildContactSignals(
    contact,
    activity.get(contact.id) ?? createEmptyActivity(contact.id),
    now,
    timeZone,
    snoozedIds
  ));
}

export function buildSmartLists(
  contacts: readonly IntelligenceContact[],
  interactions: readonly IntelligenceInteraction[],
  reminders: readonly IntelligenceReminder[],
  now = new Date(),
  timeZone = 'UTC',
  snoozes: readonly TodaySnooze[] = []
): SmartList[] {
  const activity = prepareContactActivity(interactions, reminders);
  return buildSmartListsFromSignals(buildContactSignalSet(contacts, activity, now, timeZone, activeTodaySnoozeIds(snoozes, now, timeZone)));
}

export function buildSmartListsFromActivity(
  contacts: readonly IntelligenceContact[],
  activity: ReadonlyMap<number, ContactActivitySummary>,
  now = new Date(),
  timeZone = 'UTC',
  snoozes: readonly TodaySnooze[] = []
): SmartList[] {
  return buildSmartListsFromSignals(buildContactSignalSet(contacts, activity, now, timeZone, activeTodaySnoozeIds(snoozes, now, timeZone)));
}

function buildSmartListsFromSignals(signals: ContactSignals[]): SmartList[] {
  const overdueFriends = signals
    .filter((signal) => signal.tags.some((tag) => ['friend', 'friends'].includes(tag.toLowerCase())) && signal.checkInDue)
    .sort((a, b) => b.overdueDays - a.overdueDays)
    .slice(0, 6)
    .map((signal) => ({
      id: signal.contact.id,
      name: signal.contact.name,
      reason: `${checkInTiming(signal.overdueDays)} · ${formatDaysAgo(signal.daysSinceLastContact)}`,
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
      const aScore = (a.latestInteraction ? 30 : 0) + (!a.checkInDue ? 20 : 0) + (a.company ? 10 : 0);
      const bScore = (b.latestInteraction ? 30 : 0) + (!b.checkInDue ? 20 : 0) + (b.company ? 10 : 0);
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
    .filter((signal) => signal.interactionsCount >= 2 && signal.checkInDue)
    .sort((a, b) => {
      const aScore = a.overdueDays * 2 + a.interactionsCount;
      const bScore = b.overdueDays * 2 + b.interactionsCount;
      return bScore - aScore;
    })
    .slice(0, 6)
    .map((signal) => ({
      id: signal.contact.id,
      name: signal.contact.name,
      reason: `${signal.interactionsCount} past interactions · ${checkInTiming(signal.overdueDays)}`,
      score: signal.overdueDays * 2 + signal.interactionsCount,
      subtitle: signal.company || undefined,
    }));

  return [
    {
      id: 'overdue-friends',
      title: 'Friends to reconnect with',
      description: 'People you wanted to check in with by now.',
      tone: 'focus',
      entries: overdueFriends,
    },
    {
      id: 'warm-professional-leads',
      title: 'Your professional circle',
      description: 'Keep in touch beyond the next project.',
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
      title: 'Pick up the conversation',
      description: 'Past conversations can be a good place to start again.',
      tone: 'focus',
      entries: dormantStrongTies,
    },
  ];
}

function buildDailyFeedFromSignals(
  contacts: readonly IntelligenceContact[],
  reminders: readonly IntelligenceReminder[],
  signals: ContactSignals[],
  now: Date,
  timeZone = 'UTC',
  snoozedIds: ReadonlySet<string> = new Set()
): DailyFeedItem[] {
  const items: DailyFeedItem[] = [];
  const contactsById = new Map(contacts.map((contact) => [contact.id, contact]));
  const signalsByContactId = new Map(signals.map((signal) => [signal.contact.id, signal]));

  const seenReminderContacts = new Set<number>();
  [...reminders]
    .filter((reminder) => !reminder.completed_at && !snoozedIds.has(`reminder-${reminder.id}`) && (dateInTimeZone(reminder.remind_at, timeZone) || '9999') <= dateInTimeZone(now, timeZone)!)
    .sort((a, b) => toTime(a.remind_at) - toTime(b.remind_at))
    .filter((reminder) => {
      if (seenReminderContacts.has(reminder.contact_id)) return false;
      seenReminderContacts.add(reminder.contact_id);
      return true;
    })
    .slice(0, 4)
    .forEach((reminder) => {
      const contact = contactsById.get(reminder.contact_id);
      const dueAt = toTime(reminder.remind_at);
      const dueLabel = new Date(reminder.remind_at).toLocaleString('en', {
        timeZone: normalizeTimeZone(timeZone), month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
      });
      items.push({
        id: `reminder-${reminder.id}`,
        contactId: contact?.id,
        contactName: contact?.name,
        reminderId: reminder.id,
        type: 'reminder',
        title: reminder.title,
        detail: `${contact ? `${contact.name} · ` : ''}${dueAt < now.getTime() ? 'Overdue since' : 'Due'} ${dueLabel}`,
        href: contact ? `/contacts/${contact.id}` : '/reminders',
        priority: dueAt < now.getTime() ? 'high' : 'medium',
        date: reminder.remind_at,
      });
    });

  signals
    .filter((signal) => (
      signal.birthdayDaysUntil !== null
      && signal.birthdayDaysUntil >= 0
      && signal.birthdayDaysUntil <= signal.contact.birthday_reminder_days
      && !snoozedIds.has(`birthday-${signal.contact.id}`)
    ))
    .sort((a, b) => (a.birthdayDaysUntil ?? 99) - (b.birthdayDaysUntil ?? 99))
    .slice(0, 3)
    .forEach((signal) => {
      const nextBirthday = nextBirthdayOccurrence(signal.contact.birthday!, dateInTimeZone(now, timeZone)!)!;

      items.push({
        id: `birthday-${signal.contact.id}`,
        contactId: signal.contact.id,
        contactName: signal.contact.name,
        type: 'birthday',
        title: `${signal.contact.name}'s birthday`,
        detail: signal.birthdayDaysUntil === 0 ? 'Happening today' : `In ${signal.birthdayDaysUntil} day${signal.birthdayDaysUntil === 1 ? '' : 's'}`,
        href: `/contacts/${signal.contact.id}`,
        priority: (signal.birthdayDaysUntil ?? 99) <= 1 ? 'high' : 'medium',
        date: nextBirthday.occurrence,
      });
    });

  signals
    .filter((signal) => signal.checkInDue)
    .sort((a, b) => b.overdueDays - a.overdueDays)
    .slice(0, 3)
    .forEach((signal) => {
      items.push({
        id: `overdue-${signal.contact.id}`,
        contactId: signal.contact.id,
        contactName: signal.contact.name,
        type: 'relationship',
        title: `Reconnect with ${signal.contact.name}`,
        detail: `${checkInTiming(signal.overdueDays)} · ${signal.company || signal.location || formatDaysAgo(signal.daysSinceLastContact)}`,
        href: `/contacts/${signal.contact.id}`,
        priority: signal.overdueDays > signal.contact.contact_frequency ? 'high' : 'medium',
        date: signal.contact.last_contacted || signal.contact.updated_at,
      });
    });

  const sorted = items.filter((item) => !snoozedIds.has(item.id)).sort((a, b) => {
      const priorityWeight = { high: 3, medium: 2, low: 1 };
      const priorityDifference = priorityWeight[b.priority] - priorityWeight[a.priority];
      if (priorityDifference !== 0) return priorityDifference;
      if (a.type === 'birthday' && b.type === 'birthday') {
        return toTime(a.date || null) - toTime(b.date || null);
      }
      return toTime(b.date || null) - toTime(a.date || null);
    });
  const people = new Map<string, DailyFeedItem>();
  const specificity = { reminder: 3, birthday: 2, relationship: 1, signal: 0 };
  for (const item of sorted) {
    const contact = item.contactId ? contactsById.get(item.contactId) : undefined;
    const latestInteraction = item.contactId ? signalsByContactId.get(item.contactId)?.latestInteraction : null;
    const decorated = {
      ...item,
      contactEmail: contact?.email ?? null,
      contactPhone: contact?.phone ?? null,
      lastInteraction: latestInteraction ? { date: latestInteraction.date, type: latestInteraction.type, summary: latestInteraction.summary } : null,
    };
    const key = item.contactId ? `contact-${item.contactId}` : item.id;
    const current = people.get(key);
    const reason = { id: item.id, type: item.type, title: item.title, detail: item.detail, date: item.date, reminderId: item.reminderId };
    if (current) {
      const reasons = [...(current.reasons || []), reason];
      // An explicit task or occasion is more useful than a generic cadence prompt.
      if (specificity[item.type] > specificity[current.type]) people.set(key, { ...decorated, reasons });
      else current.reasons = reasons;
    } else people.set(key, { ...decorated, reasons: [reason] });
  }
  return [...people.values()].sort((a, b) => {
    const priority = { high: 3, medium: 2, low: 1 };
    return priority[b.priority] - priority[a.priority]
      || (a.type === 'birthday' && b.type === 'birthday' ? toTime(a.date || null) - toTime(b.date || null) : 0);
  }).slice(0, 8);
}

export function buildDailyFeed(
  contacts: readonly IntelligenceContact[],
  interactions: readonly IntelligenceInteraction[],
  reminders: readonly IntelligenceReminder[],
  now = new Date(),
  timeZone = 'UTC',
  snoozes: readonly TodaySnooze[] = []
): DailyFeedItem[] {
  const activity = prepareContactActivity(interactions, reminders);
  const snoozedIds = activeTodaySnoozeIds(snoozes, now, timeZone);
  return buildDailyFeedFromSignals(
    contacts,
    reminders,
    buildContactSignalSet(contacts, activity, now, timeZone, snoozedIds),
    now,
    timeZone,
    snoozedIds
  );
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
      summary: 'Imported into Everclose CRM via the browser extension.',
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
  const activity = prepareContactActivity(interactions, reminders);
  return buildRelationshipBriefFromActivity(
    contact,
    activity.get(contact.id) ?? createEmptyActivity(contact.id),
    storedFacts
  );
}

export function buildRelationshipBriefFromActivity(
  contact: Contact,
  activity: ContactActivitySummary,
  storedFacts: RelationshipFact[],
  now = new Date(),
  timeZone = 'UTC'
): RelationshipBrief {
  const signal = buildContactSignals(contact, activity, now, timeZone);
  const facts = [...storedFacts.slice(0, 3).map((fact) => `${fact.label}: ${fact.value ?? fact.source}`)];
  const derivedFacts = buildDerivedFacts(contact).slice(0, 3).map((fact) => `${fact.label}: ${fact.value}`);
  const talkingPoints = Array.from(new Set([...facts, ...derivedFacts])).slice(0, 4);

  const latestInteraction = signal.latestInteraction;
  const latestReminder = signal.openReminders[0];

  let momentum: RelationshipBrief['momentum'] = 'steady';
  if (signal.overdueDays > signal.contact.contact_frequency || signal.daysSinceLastContact === null) {
    momentum = 'stale';
  } else if (!signal.checkInDue && signal.interactionsCount >= 2) {
    momentum = 'strong';
  }

  const summaryParts = [
    signal.company ? `Company on file: ${signal.company}.` : null,
    signal.location ? `Location on file: ${signal.location}.` : null,
    latestInteraction?.summary ? `Last interaction: ${latestInteraction.summary}.` : null,
    latestReminder ? `Open reminder: ${latestReminder.title}.` : null,
  ].filter((part): part is string => Boolean(part));

  let nextStep = 'Log a fresh note or send a quick check-in.';
  if (latestReminder) {
    nextStep = `Handle the reminder "${latestReminder.title}" next.`;
  } else if (signal.checkInDue) {
    nextStep = `${checkInTiming(signal.overdueDays)}. Reach out when it feels right and pick up a familiar thread.`;
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
      signal.daysSinceLastContact === null ? 'Start with a conversation' : signal.checkInDue
        ? 'Ready to reconnect' : momentum === 'strong'
        ? 'Recently in touch'
        : momentum === 'steady'
          ? 'On your rhythm'
          : 'Ready to reconnect',
    summary: summaryParts.join(' ') || `${contact.name} does not have much structured context yet. Add a note or import more detail to improve future suggestions.`,
    nextStep,
    talkingPoints,
    suggestedOutreach,
    momentum,
  };
}

export function buildIntelligenceOverview(
  contacts: readonly IntelligenceContact[],
  interactions: readonly IntelligenceInteraction[],
  reminders: readonly IntelligenceReminder[],
  now = new Date(),
  timeZone = 'UTC',
  snoozes: readonly TodaySnooze[] = []
) {
  const activity = prepareContactActivity(interactions, reminders);
  return buildIntelligenceOverviewFromActivity(
    contacts,
    activity,
    reminders,
    reminders.filter((reminder) => !reminder.completed_at).length,
    now,
    timeZone,
    snoozes
  );
}

export function buildIntelligenceOverviewFromActivity(
  contacts: readonly IntelligenceContact[],
  activity: ReadonlyMap<number, ContactActivitySummary>,
  feedReminders: readonly IntelligenceReminder[],
  openReminderCount: number,
  now = new Date(),
  timeZone = 'UTC',
  snoozes: readonly TodaySnooze[] = []
) {
  const snoozedIds = activeTodaySnoozeIds(snoozes, now, timeZone);
  const signals = buildContactSignalSet(contacts, activity, now, timeZone, snoozedIds);
  const smartLists = buildSmartListsFromSignals(signals);
  const feed = buildDailyFeedFromSignals(contacts, feedReminders, signals, now, timeZone, snoozedIds);
  const overdueCount = signals.filter((signal) => signal.overdueDays > 0).length;
  const checkInsDueCount = signals.filter((signal) => signal.checkInDue).length;
  const strongRelationships = signals.filter((signal) => {
    if (signal.daysSinceLastContact === null || signal.checkInDue) return false;
    return signal.daysSinceLastContact <= Math.max(7, Math.floor((signal.contact.contact_frequency || 14) / 2));
  }).length;
  return {
    stats: {
      totalContacts: contacts.length,
      overdueCount,
      checkInsDueCount,
      openReminderCount,
      strongRelationships,
    },
    smartLists,
    feed,
    firstSteps: buildFirstSteps(contacts, activity),
    snoozes: snoozes.filter((item) => snoozedIds.has(item.id)),
    capabilities: DATA_CAPABILITIES,
  };
}
