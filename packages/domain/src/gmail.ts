export type GmailMetadata = { id: string; threadId: string; historyId: string; receivedAt: number; labelIds: string[];
  headers: Partial<Record<'from' | 'to' | 'cc' | 'bcc' | 'message-id' | 'in-reply-to' | 'list-id' | 'precedence' | 'auto-submitted' | 'subject', string[]>> };
export type GmailChoices = { label_ids: string[]; own_addresses: string[]; mode: 'existing_people' | 'review_inbox';
  past_days: number; scan_limit: number; retain_subject: boolean };
export type GmailMessageFacts = { id: string; thread_id: string; received_at: number; direction: 'incoming' | 'outgoing' | 'unknown';
  participants: Array<{ email: string; roles: Array<'from' | 'to' | 'cc' | 'bcc'> }>;
  participants_incomplete: boolean; subject: string | null; message_id: string | null };
export class GmailChoicesError extends Error {}
export function gmailAddress(raw: unknown) {
  if (typeof raw !== 'string') throw new GmailChoicesError('Use a complete email address.');
  const value = raw.trim().normalize('NFC');
  // Conservative addr-spec subset: never guess inside a phrase, quoted local
  // part, group, route address or domain literal. Display names are parsed below.
  const parts = value.split('@');
  const octets = (text: string) => Array.from(text).reduce((sum, character) => {
    const point = character.codePointAt(0)!; return sum + (point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4);
  }, 0);
  if (parts.length !== 2 || octets(value) > 320 || octets(parts[0]) > 64
    || !/^[\p{L}\p{M}\p{N}!#$%&'*+/=?^_`{|}~-]+(?:\.[\p{L}\p{M}\p{N}!#$%&'*+/=?^_`{|}~-]+)*$/u.test(parts[0])
    || octets(parts[1]) > 255 || parts[1].split('.').some((label) => octets(label) > 63
      || !/^[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}-]*[\p{L}\p{N}])?$/u.test(label))) throw new GmailChoicesError('Use a complete email address.');
  return value.toLowerCase();
}
export function readGmailChoices(raw: unknown, primary: string): GmailChoices {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new GmailChoicesError('Review mailbox choices before downloading.');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'label_ids,mode,own_addresses,past_days,retain_subject,scan_limit'
    || !Array.isArray(value.label_ids) || value.label_ids.length < 1 || value.label_ids.length > 20
    || value.label_ids.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(id) || ['SPAM', 'TRASH', 'DRAFT'].includes(id))
    || new Set(value.label_ids).size !== value.label_ids.length || !Array.isArray(value.own_addresses) || value.own_addresses.length > 21
    || typeof value.mode !== 'string' || !['existing_people', 'review_inbox'].includes(value.mode) || !Number.isInteger(value.past_days) || Number(value.past_days) < 1 || Number(value.past_days) > 90
    || !Number.isInteger(value.scan_limit) || Number(value.scan_limit) < 100 || Number(value.scan_limit) > 10000 || typeof value.retain_subject !== 'boolean') {
    throw new GmailChoicesError('Choose 1–20 labels, 1–90 days, up to 10,000 scanned messages and explicit subject retention.');
  }
  const aliases = value.own_addresses.map(gmailAddress);
  if (new Set(aliases).size !== aliases.length) throw new GmailChoicesError('List each of your mailbox addresses once.');
  const own = [...new Set([gmailAddress(primary), ...aliases])].sort();
  if (own.length > 21) throw new GmailChoicesError('Use at most twenty additional mailbox addresses.');
  return { label_ids: (value.label_ids as string[]).slice().sort(), own_addresses: own,
    mode: value.mode as GmailChoices['mode'], past_days: Number(value.past_days), scan_limit: Number(value.scan_limit), retain_subject: value.retain_subject };
}

/** Bounded address-list scanner. Quoted phrases/comments protect their commas;
 * unsupported or malformed syntax is marked incomplete, never guessed into a match.
 */
export function gmailHeaderAddresses(values: string[]) {
  const addresses = new Set<string>(); let incomplete = false, total = 0;
  for (const value of values) {
    total += value.length;
    if (value.length > 8192 || total > 32768 || /[\u0000-\u001f\u007f]/u.test(value)) { incomplete = true; continue; }
    let quoted = false, escape = false, comment = 0, angle = false, group = false, token = '', structural = false;
    const field = new Set<string>();
    function emit() {
      const raw = token.trim(); token = ''; if (!raw) return;
      try {
        const start = raw.indexOf('<'), end = raw.indexOf('>');
        const candidate = start >= 0 ? raw.slice(start + 1, end) : raw;
        if (start >= 0 && (end <= start || raw.slice(end + 1).trim() || raw.slice(start + 1).includes('<') || raw.slice(end + 1).includes('>'))) throw new Error();
        field.add(gmailAddress(candidate));
        if (field.size > 100) throw new Error();
      } catch { incomplete = true; }
    }
    for (const character of value) {
      if (escape) { if (!comment) token += character; escape = false; continue; }
      if ((quoted || comment) && character === '\\') { if (!comment) token += character; escape = true; continue; }
      if (comment) { if (character === '(') { comment++; if (comment > 8) structural = true; } if (character === ')') comment--; continue; }
      if (!quoted && character === '(') { comment = 1; token += ' '; continue; }
      if (character === '"') { quoted = !quoted; token += character; continue; }
      if (!quoted && character === '<') { if (angle) structural = true; angle = true; }
      if (!quoted && character === '>') { if (!angle) structural = true; angle = false; }
      if (!quoted && !angle && character === ':') { if (group || !token.trim()) structural = true; group = true; token = ''; continue; }
      if (!quoted && !angle && (character === ',' || character === ';')) {
        if (character === ';') { if (!group) structural = true; group = false; } emit(); continue;
      }
      token += character;
    }
    if (quoted || comment || angle || escape || group) structural = true;
    emit();
    if (structural || field.size > 100) incomplete = true;
    else for (const email of field) addresses.add(email);
  }
  if (addresses.size > 100) return { addresses: [], incomplete: true };
  return { addresses: [...addresses].sort(), incomplete };
}

/** Only the consented projection is persisted. No raw headers, names, bodies,
 * snippets, attachments, own addresses, bulk traffic or inferred CRM interaction.
 */
export function gmailMessageFacts(message: GmailMetadata, choices: GmailChoices, start: number, end: number): GmailMessageFacts | null {
  if (message.receivedAt < start || message.receivedAt > end || !message.labelIds.some((id) => choices.label_ids.includes(id))
    || message.labelIds.some((id) => ['SPAM', 'TRASH', 'DRAFT'].includes(id))
    || (message.headers['list-id']?.some((value) => value.trim()) ?? false)
    || (message.headers.precedence?.some((value) => /^(?:bulk|list|junk)$/iu.test(value.trim())) ?? false)
    || (message.headers['auto-submitted']?.some((value) => value.trim().toLowerCase() !== 'no') ?? false)) return null;
  const own = new Set(choices.own_addresses), participants = new Map<string, Set<'from' | 'to' | 'cc' | 'bcc'>>();
  let incomplete = false; const parsed: Record<string, string[]> = {};
  for (const role of ['from', 'to', 'cc', 'bcc'] as const) {
    const result = gmailHeaderAddresses(message.headers[role] ?? []); parsed[role] = result.addresses; incomplete ||= result.incomplete;
    for (const email of result.addresses) if (!own.has(email)) { const roles = participants.get(email) ?? new Set(); roles.add(role); participants.set(email, roles); }
  }
  if (participants.size > 100) { participants.clear(); incomplete = true; }
  const from = parsed.from;
  const direction = !incomplete && from.length === 1 && own.has(from[0]) && message.labelIds.includes('SENT') ? 'outgoing'
    : !incomplete && from.length === 1 && !own.has(from[0]) && [...parsed.to, ...parsed.cc, ...parsed.bcc].some((email) => own.has(email)) ? 'incoming' : 'unknown';
  const subject = choices.retain_subject && message.headers.subject?.length === 1 ? Array.from(message.headers.subject[0]).slice(0, 512).join('') : null;
  const identifier = message.headers['message-id'];
  const messageId = identifier?.length === 1 && /^<[^\s<>\u0000-\u001f\u007f]{1,510}>$/u.test(identifier[0].trim()) ? identifier[0].trim() : null;
  return { id: message.id, thread_id: message.threadId, received_at: message.receivedAt, direction, participants_incomplete: incomplete,
    participants: [...participants].sort(([a], [b]) => a.localeCompare(b)).map(([email, roles]) => ({ email, roles: [...roles].sort() })), subject, message_id: messageId };
}

export type GmailDownloadRun = { id: string; mode: 'full' | 'incremental'; phase: string; status: string;
  pages: number; processed: number; limited: boolean; retry_at: number; issue: string | null };
export type GmailSourceReview = { settings_revision: number; choices: GmailChoices; generation: string | null;
  coverage: 'none' | 'scanned' | 'limited'; window_start: number | null; window_end: number | null;
  last_downloaded_at: string | null; run: GmailDownloadRun | null;
  schedule: { enabled: boolean; interval: number; revision: number; next_at: number; repair_required: boolean } };
export type GmailMessagePage = { generation: string | null; coverage: GmailSourceReview['coverage']; more: boolean; next: string | null;
  messages: Array<{ facts: GmailMessageFacts; observed_at: number }> };
