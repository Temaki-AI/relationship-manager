import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { differenceInDays, parseISO, format } from "date-fns";
import type { Contact } from "./db";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
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
