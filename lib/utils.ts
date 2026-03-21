import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { differenceInDays, parseISO, format } from "date-fns";
import { createHash } from "crypto";
import type { Contact } from "./db";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function getGravatarUrl(email: string | null, size = 200): string | null {
  if (!email) return null;
  const hash = createHash('md5').update(email.toLowerCase().trim()).digest('hex');
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=404`;
}

export function daysBetween(dateString: string | null, endDate: Date): number {
  if (!dateString) return 999;
  try {
    const startDate = parseISO(dateString);
    return differenceInDays(endDate, startDate);
  } catch {
    return 999;
  }
}

export function calculateRelationshipHealth(contact: Contact): number {
  if (!contact.last_contacted) return 100;
  
  const daysSince = daysBetween(contact.last_contacted, new Date());
  const targetDays = contact.contact_frequency || 14;
  
  const health = Math.max(0, 100 - ((daysSince / targetDays) * 100));
  return Math.round(health);
}

export function getHealthColor(health: number): string {
  if (health >= 75) return "text-green-600 bg-green-50";
  if (health >= 50) return "text-yellow-600 bg-yellow-50";
  return "text-red-600 bg-red-50";
}

export function getHealthBadge(health: number): string {
  if (health >= 75) return "Healthy";
  if (health >= 50) return "Needs Attention";
  return "Neglected";
}

export function formatDate(dateString: string | null): string {
  if (!dateString) return "Never";
  try {
    return format(parseISO(dateString), "MMM d, yyyy");
  } catch {
    return "Invalid date";
  }
}

export function formatRelativeDate(dateString: string | null): string {
  if (!dateString) return "Never";
  const days = daysBetween(dateString, new Date());
  
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return `${weeks} week${weeks > 1 ? 's' : ''} ago`;
  }
  const months = Math.floor(days / 30);
  return `${months} month${months > 1 ? 's' : ''} ago`;
}

export function parseTags(tagsString: string | null): string[] {
  if (!tagsString) return [];
  try {
    return JSON.parse(tagsString);
  } catch {
    return [];
  }
}

export function parseGiftIdeas(ideasString: string | null): string[] {
  if (!ideasString) return [];
  try {
    return JSON.parse(ideasString);
  } catch {
    return [];
  }
}

export function getInitials(name: string): string {
  return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
}

export function getAvatarColor(name: string): string {
  const colors = [
    'from-rose-400 to-pink-500',
    'from-violet-400 to-purple-500',
    'from-blue-400 to-indigo-500',
    'from-emerald-400 to-teal-500',
    'from-amber-400 to-orange-500',
    'from-cyan-400 to-blue-500',
    'from-fuchsia-400 to-pink-500',
    'from-lime-400 to-green-500',
  ];
  const index = name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % colors.length;
  return colors[index];
}

export function getContactAvatar(contact: { name: string; email: string | null; photo_url: string | null }): {
  type: 'image' | 'initials';
  url?: string;
  initials?: string;
  color?: string;
} {
  // Priority 1: Manual photo_url
  if (contact.photo_url) {
    return { type: 'image', url: contact.photo_url };
  }
  
  // Priority 2: Gravatar (if email exists)
  const gravatarUrl = getGravatarUrl(contact.email);
  if (gravatarUrl) {
    return { type: 'image', url: gravatarUrl };
  }
  
  // Priority 3: Generated avatar with initials
  return {
    type: 'initials',
    initials: getInitials(contact.name),
    color: getAvatarColor(contact.name),
  };
}
