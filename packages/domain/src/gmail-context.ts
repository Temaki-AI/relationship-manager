import { gmailAddress } from './gmail.ts';
import { isSyncUuid } from './sync.ts';

export const GMAIL_CONTEXT_PROTOCOL = 1;
export const GMAIL_CONTEXT_MAX_BYTES = 1024 * 1024;
export const GMAIL_CONTEXT_MAX_SOURCES = 32;
export type GmailContextSource = { id: string; email: string; past_days: number; retain_subject: boolean };
export type GmailContextManifest = { protocol: 1; scope: string; epoch: string; directory_ready: boolean; valid_until: number; sources: GmailContextSource[] };
export type GmailContextMessage = { id: string; thread_id: string; received_at: number; direction: 'incoming' | 'outgoing' | 'unknown'; subject: string | null; linked_addresses: string[] };
export type GmailContextPage = { protocol: 1; scope: string; source_id: string; person_id: string; messages: GmailContextMessage[]; next: string | null };
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function object(raw: unknown, keys: string) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== keys) throw new Error('Invalid reviewed email context.');
  return raw as Record<string, unknown>;
}
function address(raw: unknown): string {
  const value = gmailAddress(raw); if (value !== raw) throw new Error('Invalid reviewed email address.'); return value;
}
export function readGmailContextManifest(raw: unknown): GmailContextManifest {
  const value = object(raw, 'directory_ready,epoch,protocol,scope,sources,valid_until');
  if (value.protocol !== 1 || !digest(value.scope) || !isSyncUuid(value.epoch) || typeof value.directory_ready !== 'boolean'
    || !Number.isSafeInteger(value.valid_until) || Number(value.valid_until) <= 0 || !Array.isArray(value.sources) || value.sources.length > GMAIL_CONTEXT_MAX_SOURCES) throw new Error('Invalid reviewed email catalog.');
  const sources = value.sources.map((raw) => {
    const source = object(raw, 'email,id,past_days,retain_subject');
    if (!isSyncUuid(source.id) || !Number.isInteger(source.past_days) || Number(source.past_days) < 1 || Number(source.past_days) > 90 || typeof source.retain_subject !== 'boolean') throw new Error('Invalid reviewed email source.');
    return { id: source.id, email: address(source.email), past_days: Number(source.past_days), retain_subject: source.retain_subject };
  });
  if (new Set(sources.map((source) => source.id)).size !== sources.length) throw new Error('Repeated reviewed email source.');
  return { protocol: 1, scope: value.scope, epoch: value.epoch, directory_ready: value.directory_ready, valid_until: Number(value.valid_until), sources };
}
export function readGmailContextPage(raw: unknown, manifest: GmailContextManifest, sourceId: string, personId: string): GmailContextPage {
  const value = object(raw, 'messages,next,person_id,protocol,scope,source_id');
  const source = manifest.sources.find((source) => source.id === sourceId);
  if (!source || !manifest.directory_ready || value.protocol !== 1 || value.scope !== manifest.scope || value.source_id !== sourceId || value.person_id !== personId || !isSyncUuid(personId)
    || !Array.isArray(value.messages) || value.messages.length > 50 || !(value.next === null || typeof value.next === 'string' && value.next.length > 0 && value.next.length <= 1024)) throw new Error('Reviewed email context changed.');
  const messages = value.messages.map((raw) => {
    const message = object(raw, 'direction,id,linked_addresses,received_at,subject,thread_id');
    if (![message.id, message.thread_id].every((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,256}$/u.test(id))
      || !Number.isSafeInteger(message.received_at) || Number(message.received_at) < 0 || !['incoming', 'outgoing', 'unknown'].includes(String(message.direction))
      || !(message.subject === null || source.retain_subject && typeof message.subject === 'string' && Array.from(message.subject).length <= 512)
      || !Array.isArray(message.linked_addresses) || message.linked_addresses.length < 1 || message.linked_addresses.length > 100) throw new Error('Invalid reviewed message metadata.');
    const linked = message.linked_addresses.map(address);
    if (new Set(linked).size !== linked.length) throw new Error('Repeated reviewed address.');
    return { id: String(message.id), thread_id: String(message.thread_id), received_at: Number(message.received_at), direction: message.direction as GmailContextMessage['direction'], subject: message.subject as string | null, linked_addresses: linked };
  });
  if (new Set(messages.map((message) => message.id)).size !== messages.length || value.next !== null && !messages.length
    || messages.some((message, i) => i > 0 && (message.received_at > messages[i - 1].received_at || message.received_at === messages[i - 1].received_at && message.id <= messages[i - 1].id))) throw new Error('Invalid reviewed email page order.');
  return { protocol: 1, scope: manifest.scope, source_id: sourceId, person_id: personId, messages, next: value.next as string | null };
}
