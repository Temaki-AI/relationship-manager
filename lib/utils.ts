import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { differenceInDays, parseISO, format } from "date-fns";
import { normalizeWebUrl } from "./contact-input.ts";
import { isEmbeddedContactPhoto } from "./contact-photo.ts";

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
    const parsed = JSON.parse(tagsString);
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === 'string')
      : [];
  } catch {
    return [];
  }
}

export function parseGiftIdeas(ideasString: string | null): string[] {
  if (!ideasString) return [];
  try {
    const parsed = JSON.parse(ideasString);
    return Array.isArray(parsed)
      ? parsed.filter((idea): idea is string => typeof idea === 'string')
      : [];
  } catch {
    return [];
  }
}

export function parseCustomFields(customFieldsString: string | null): Record<string, unknown> {
  if (!customFieldsString) return {};
  try {
    const parsed = JSON.parse(customFieldsString);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function getSocialLinks(customFieldsString: string | null): Record<string, string> {
  const customFields = parseCustomFields(customFieldsString);
  const social = customFields.social;

  if (!social || typeof social !== 'object') {
    return {};
  }

  return Object.fromEntries(
    Object.entries(social).flatMap(([network, value]) => {
      const url = normalizeWebUrl(value);
      return url ? [[network, url]] : [];
    })
  ) as Record<string, string>;
}

export function getInitials(name: string): string {
  return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
}

export function getAvatarColor(name: string): string {
  const colors = [
    'from-rose-700 to-pink-800',
    'from-violet-700 to-purple-800',
    'from-blue-700 to-indigo-800',
    'from-emerald-700 to-teal-800',
    'from-amber-700 to-orange-800',
    'from-cyan-700 to-blue-800',
    'from-fuchsia-700 to-pink-800',
    'from-lime-700 to-green-800',
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
  if (isEmbeddedContactPhoto(contact.photo_url)) {
    return { type: 'image', url: contact.photo_url };
  }
  if (contact.photo_url && /^\/api\/contacts\/[1-9]\d*\/photo$/.test(contact.photo_url)) {
    return { type: 'image', url: contact.photo_url };
  }

  return {
    type: 'initials',
    initials: getInitials(contact.name),
    color: getAvatarColor(contact.name),
  };
}

export async function getResponseErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.clone().json();
    if (data && typeof data.error === 'string' && data.error.trim()) {
      return data.error;
    }
  } catch {
    // Ignore parse failures and fall back to status-based messaging.
  }

  return response.status ? `${fallback} (${response.status})` : fallback;
}

export class ResponseError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ResponseError';
    this.status = status;
  }
}

export async function createResponseError(response: Response, fallback: string): Promise<ResponseError> {
  return new ResponseError(await getResponseErrorMessage(response, fallback), response.status);
}

export function createIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('Secure request identifiers are not available in this browser.');
  }
  return globalThis.crypto.randomUUID();
}
