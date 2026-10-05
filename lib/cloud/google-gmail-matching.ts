import { gmailAddress, readGmailChoices } from '@/packages/domain/src/gmail';
import { gmailMatchStatus, type GmailCandidate, type GmailCorrespondent, type GmailMatchPage, type GmailMatchReceipt, type GmailMatchScope, type GmailPersonContext } from '@/packages/domain/src/gmail-matching';
import { isSyncUuid } from '@/packages/domain/src/sync';
import { fingerprintIdempotencyInput } from '@/lib/idempotency';
import { gmailDirectoryState, advanceGmailDirectory } from './gmail-contact-directory';
import { gmailSourceAccess, gmailSourceOwner } from './google-gmail-downloads';
import { maintenanceGuard, removeGuard } from './recovery-storage';
import { ProviderConnectionError } from './provider-vault';
import type { ConnectionActor } from './provider-connections';

type DB = CloudflareEnv['DB'];
type Rule = { email: string; action: 'link' | 'exclude'; target_public_id: string | null; candidate_basis: string };
type CandidateRow = GmailCandidate & { email: string; total: number };
type Resource = { choices: string; settings_revision: number; active_generation: string | null; revision: number };
type Scope = Awaited<ReturnType<typeof scope>>;
const changed = () => new ProviderConnectionError('Gmail or contact matching changed. Refresh this review before continuing.', 409);

async function scope(db: DB, actor: ConnectionActor, id: string, prepare = false) {
  const access = await gmailSourceAccess(db, actor, id);
  const resource = await db.prepare(`SELECT r.choices,r.settings_revision,r.active_generation,m.revision FROM provider_gmail_resources r
    JOIN provider_gmail_matching m ON m.connection_id=r.connection_id WHERE r.connection_id=?`).bind(id).first<Resource>();
  if (!resource) throw new ProviderConnectionError('Save mailbox choices and finish a metadata download before matching.', 409);
  let directory = await gmailDirectoryState(db, actor);
  if (prepare && !directory.ready) directory = await advanceGmailDirectory(db, actor);
  const choices = readGmailChoices(JSON.parse(resource.choices), access.email);
  return { access, resource, directory, choices, window: Date.now() - choices.past_days * 86400000 };
}
function publicScope(s: Scope): GmailMatchScope {
  return { epoch: s.access.dataset_epoch, authorization_revision: s.access.authorization_revision, settings_revision: s.resource.settings_revision,
    generation: s.resource.active_generation, directory_revision: s.directory.revision, matching_revision: s.resource.revision, directory_ready: s.directory.ready };
}
function condition(s: Scope, actor: ConnectionActor, ready = s.directory.ready) {
  const owner = gmailSourceOwner(s.access, actor);
  return { condition: owner.condition + ` AND EXISTS(SELECT 1 FROM provider_gmail_resources r JOIN provider_gmail_matching m ON m.connection_id=r.connection_id
      WHERE r.connection_id=? AND r.settings_revision=? AND r.active_generation IS ? AND m.revision=?)
    AND EXISTS(SELECT 1 FROM gmail_contact_directory d WHERE d.workspace_id=? AND d.revision=?${ready ? " AND d.bootstrapped=1 AND NOT EXISTS(SELECT 1 FROM gmail_contact_directory_pending p WHERE p.workspace_id=d.workspace_id)" : ''})`,
  values: [...owner.values, s.access.id, s.resource.settings_revision, s.resource.active_generation, s.resource.revision, actor.workspaceId, s.directory.revision] };
}
async function fence(db: DB, actor: ConnectionActor, s: Scope) {
  const guard = crypto.randomUUID(), current = condition(s, actor);
  await db.batch([maintenanceGuard(db, guard, current.condition, current.values), removeGuard(db, guard)]);
}
function queryScope(query: URLSearchParams, s: Scope, person = false) {
  const allowed = ['generation', 'directory_revision', 'matching_revision', 'after'];
  if ([...query.keys()].some((key) => !allowed.includes(key) || query.getAll(key).length !== 1)) throw changed();
  if (query.has('generation') && query.get('generation') !== s.resource.active_generation) throw changed();
  for (const key of ['directory_revision', 'matching_revision'] as const) {
    const value = query.get(key), expected = key === 'directory_revision' ? s.directory.revision : s.resource.revision;
    if (value !== null && (!/^\d{1,16}$/u.test(value) || Number(value) !== expected)) throw changed();
  }
  if (query.has('after') && allowed.some((key) => !query.has(key))) throw changed();
  const after = query.get('after');
  if (after !== null && (!after || after.length > (person ? 1024 : 320))) throw changed();
  if (after !== null && !person && gmailAddress(after) !== after) throw changed();
  return after;
}
async function candidatesFor(db: DB, actor: ConnectionActor, emails: string[]) {
  if (!emails.length) return new Map<string, CandidateRow[]>();
  const rows: CandidateRow[] = (await db.prepare(`WITH matches AS (
    SELECT e.email,c.id,c.public_id,c.name,COUNT(*) OVER(PARTITION BY e.email) AS total,
      ROW_NUMBER() OVER(PARTITION BY e.email ORDER BY c.public_id) AS position
    FROM gmail_contact_directory_entries e JOIN contacts c ON c.workspace_id=e.workspace_id AND c.public_id=e.contact_public_id
    WHERE e.workspace_id=? AND e.email IN(SELECT value FROM json_each(?)))
    SELECT email,id,public_id,name,total FROM matches WHERE position<=21 ORDER BY email,public_id`)
    .bind(actor.workspaceId, JSON.stringify(emails)).all<CandidateRow>()).results;
  const groups = new Map<string, CandidateRow[]>();
  for (const row of rows) groups.set(row.email, [...(groups.get(row.email) ?? []), row]);
  return groups;
}
async function resolveRules(db: DB, actor: ConnectionActor, rules: Rule[]) {
  const ids = [...new Set(rules.flatMap((rule) => rule.action === 'link' ? [rule.target_public_id!, ...JSON.parse(rule.candidate_basis) as string[]] : []))];
  if (!ids.length) return new Map<string, string>();
  const rows: Array<{ original: string; canonical: string }> = (await db.prepare(`SELECT c.public_id AS original,c.public_id AS canonical FROM contacts c
      WHERE c.workspace_id=? AND c.public_id IN(SELECT value FROM json_each(?))
    UNION SELECT a.public_id AS original,c.public_id AS canonical FROM contact_merge_aliases a
      JOIN contacts c ON c.workspace_id=a.workspace_id AND c.public_id=a.canonical_public_id
      WHERE a.workspace_id=? AND a.public_id IN(SELECT value FROM json_each(?))`)
    .bind(actor.workspaceId, JSON.stringify(ids), actor.workspaceId, JSON.stringify(ids)).all<{ original: string; canonical: string }>()).results;
  return new Map(rows.map((row) => [row.original, row.canonical]));
}
function classified(email: string, rows: CandidateRow[], rule: Rule | undefined, aliases: Map<string, string>) {
  const candidates = rows.slice(0, 20).map(({ public_id, id, name }) => ({ public_id, id, name }));
  const more = (rows[0]?.total ?? 0) > 20;
  const resolved = rule ? { action: rule.action, target: rule.target_public_id ? aliases.get(rule.target_public_id) ?? null : null,
    basis: (JSON.parse(rule.candidate_basis) as string[]).map((id) => aliases.get(id) ?? null) } : null;
  const status = gmailMatchStatus(candidates, more, resolved);
  return { email, candidates, candidates_more: more, status, linked_person: status === 'linked' ? candidates.find((candidate) => candidate.public_id === resolved!.target)! : null };
}

/** Preparing the derived CRM index is an explicit bounded action, never a Gmail read. */
export async function prepareGmailMatching(db: DB, actor: ConnectionActor, id: string) {
  await gmailSourceAccess(db, actor, id);
  await advanceGmailDirectory(db, actor);
  const s = await scope(db, actor, id); await fence(db, actor, s);
  return publicScope(s);
}
export async function reviewGmailMatches(db: DB, actor: ConnectionActor, id: string, query = new URLSearchParams()): Promise<GmailMatchPage> {
  const s = await scope(db, actor, id, !query.has('directory_revision')), after = queryScope(query, s);
  let correspondents: GmailCorrespondent[] = [], more = false;
  if (s.directory.ready && s.resource.active_generation) {
    const rows: Array<{ email: string; messages: number; latest_at: number }> = (await db.prepare(`SELECT p.email,COUNT(*) AS messages,MAX(p.received_at) AS latest_at FROM provider_gmail_participants p
      WHERE p.connection_id=? AND p.generation=? AND p.received_at>=? AND p.email>?
        AND (?='review_inbox' OR EXISTS(SELECT 1 FROM gmail_contact_directory_entries e WHERE e.workspace_id=? AND e.email=p.email)
          OR EXISTS(SELECT 1 FROM provider_gmail_match_rules r WHERE r.connection_id=p.connection_id AND r.email=p.email))
      GROUP BY p.email ORDER BY p.email LIMIT 51`).bind(id, s.resource.active_generation, s.window, after ?? '', s.choices.mode, actor.workspaceId)
      .all<{ email: string; messages: number; latest_at: number }>()).results;
    more = rows.length > 50; const page = rows.slice(0, 50), emails = page.map((row) => row.email);
    const candidates = await candidatesFor(db, actor, emails);
    const rules: Rule[] = (await db.prepare('SELECT * FROM provider_gmail_match_rules WHERE connection_id=? AND email IN(SELECT value FROM json_each(?))').bind(id, JSON.stringify(emails)).all<Rule>()).results;
    const aliases = await resolveRules(db, actor, rules), byEmail = new Map(rules.map((rule) => [rule.email, rule]));
    correspondents = page.map((row) => ({ ...row, ...classified(row.email, candidates.get(row.email) ?? [], byEmail.get(row.email), aliases) }));
  }
  await fence(db, actor, s);
  return { ...publicScope(s), mode: s.choices.mode, correspondents, more, next: more ? correspondents.at(-1)!.email : null };
}
function publicReceipt(row: GmailMatchReceipt): GmailMatchReceipt {
  return { operation_id: row.operation_id, revision: row.revision, action: row.action, email: row.email, target_public_id: row.target_public_id };
}
export async function decideGmailMatch(db: DB, actor: ConnectionActor, id: string, body: Record<string, unknown>): Promise<GmailMatchReceipt> {
  const s = await scope(db, actor, id);
  if (Object.keys(body).sort().join(',') !== 'action,email,expected_authorization_revision,expected_directory_revision,expected_epoch,expected_generation,expected_matching_revision,expected_settings_revision,operation_id,target_public_id'
    || !isSyncUuid(body.operation_id) || typeof body.action !== 'string' || !['link', 'exclude', 'clear'].includes(body.action)
    || typeof body.email !== 'string' || gmailAddress(body.email) !== body.email
    || !isSyncUuid(body.expected_generation) || !Number.isSafeInteger(body.expected_directory_revision) || !Number.isSafeInteger(body.expected_matching_revision)
    || (body.action === 'link' ? !isSyncUuid(body.target_public_id) : body.target_public_id !== null)
    || body.expected_epoch !== s.access.dataset_epoch || body.expected_authorization_revision !== s.access.authorization_revision || body.expected_settings_revision !== s.resource.settings_revision
    || s.choices.own_addresses.includes(body.email)) throw changed();
  const fingerprint = fingerprintIdempotencyInput(body);
  const previous = await db.prepare('SELECT * FROM provider_gmail_match_receipts WHERE connection_id=? AND operation_id=?').bind(id, body.operation_id).first<GmailMatchReceipt & { fingerprint: string }>();
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new ProviderConnectionError('This review operation was already used for a different choice.', 409);
    await fence(db, actor, s); return publicReceipt(previous);
  }
  if (!s.directory.ready || body.expected_generation !== s.resource.active_generation || body.expected_directory_revision !== s.directory.revision || body.expected_matching_revision !== s.resource.revision) throw changed();
  const present = await db.prepare('SELECT 1 FROM provider_gmail_participants WHERE connection_id=? AND generation=? AND email=? AND received_at>=? LIMIT 1')
    .bind(id, s.resource.active_generation, body.email, s.window).first();
  if (!present) throw new ProviderConnectionError('This correspondent is outside the retained mailbox window. Review a fresh download.', 409);
  const candidates = (await candidatesFor(db, actor, [body.email])).get(body.email) ?? [];
  if (body.action === 'link' && (candidates.length > 20 || !candidates.some((person) => person.public_id === body.target_public_id)))
    throw new ProviderConnectionError('Choose a current person with this email method. More than twenty shared-address candidates need contact review.', 409);
  const count = await db.prepare('SELECT count(*) n FROM provider_gmail_match_receipts WHERE connection_id=?').bind(id).first<{ n: number }>();
  if ((count?.n ?? 0) >= 20000) throw new ProviderConnectionError('This retained mailbox window has reached its 20,000-choice review limit. Review a shorter window before saving more choices.', 413);
  const current = condition(s, actor, true), guard = crypto.randomUUID();
  const receipt = { operation_id: body.operation_id, revision: s.resource.revision + 1, action: body.action as GmailMatchReceipt['action'], email: body.email, target_public_id: body.target_public_id as string | null };
  const statements = [maintenanceGuard(db, guard, current.condition + ' AND (SELECT COUNT(*) FROM provider_gmail_match_receipts WHERE connection_id=?)<20000', [...current.values, id]),
    db.prepare('DELETE FROM provider_gmail_match_rules WHERE connection_id=? AND email=?').bind(id, body.email)];
  if (body.action !== 'clear') statements.push(db.prepare('INSERT INTO provider_gmail_match_rules(connection_id,email,action,target_public_id,candidate_basis) VALUES(?,?,?,?,?)')
    .bind(id, body.email, body.action, body.target_public_id, JSON.stringify(body.action === 'link' ? candidates.map((person) => person.public_id).sort() : [])));
  statements.push(db.prepare('UPDATE provider_gmail_matching SET revision=revision+1 WHERE connection_id=?').bind(id),
    db.prepare('INSERT INTO provider_gmail_match_receipts(connection_id,operation_id,fingerprint,revision,action,email,target_public_id) VALUES(?,?,?,?,?,?,?)')
      .bind(id, receipt.operation_id, fingerprint, receipt.revision, receipt.action, receipt.email, receipt.target_public_id), removeGuard(db, guard));
  try { await db.batch(statements); }
  catch (error) {
    const replay = await db.prepare('SELECT * FROM provider_gmail_match_receipts WHERE connection_id=? AND operation_id=?').bind(id, body.operation_id).first<GmailMatchReceipt & { fingerprint: string }>();
    if (replay?.fingerprint === fingerprint) { const fresh = await scope(db, actor, id); await fence(db, actor, fresh); return publicReceipt(replay); }
    throw error;
  }
  // Mutations return their receipt, not private metadata fetched before the write.
  return receipt;
}
export async function reviewGmailPersonContext(db: DB, actor: ConnectionActor, id: string, publicId: string, query = new URLSearchParams()): Promise<GmailPersonContext> {
  if (!isSyncUuid(publicId)) throw new ProviderConnectionError('Choose a saved person.', 404);
  const s = await scope(db, actor, id, !query.has('directory_revision')), after = queryScope(query, s, true);
  const person = await db.prepare(`SELECT id,public_id,name FROM contacts WHERE workspace_id=? AND
    (public_id=? OR public_id=(SELECT canonical_public_id FROM contact_merge_aliases WHERE workspace_id=? AND public_id=?))`)
    .bind(actor.workspaceId, publicId, actor.workspaceId, publicId).first<GmailCandidate>();
  if (!person) throw new ProviderConnectionError('Person not found.', 404);
  let cursor: { at: number; id: string } | null = null;
  if (after) { try { const parsed = JSON.parse(after) as { at: number; id: string };
    if (Object.keys(parsed).sort().join(',') !== 'at,id' || !Number.isSafeInteger(parsed.at) || parsed.at < 0 || typeof parsed.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(parsed.id)) throw changed(); cursor = parsed;
  } catch { throw changed(); } }
  let messages: GmailPersonContext['messages'] = [], more = false;
  if (s.directory.ready && s.resource.active_generation) {
    const rules: Rule[] = (await db.prepare(`SELECT r.* FROM provider_gmail_match_rules r WHERE r.connection_id=? AND r.action='link'
      AND EXISTS(SELECT 1 FROM gmail_contact_directory_entries e WHERE e.workspace_id=? AND e.email=r.email AND e.contact_public_id=?) LIMIT 258`)
      .bind(id, actor.workspaceId, person.public_id).all<Rule>()).results;
    if (rules.length > 257) throw changed();
    const candidates = await candidatesFor(db, actor, rules.map((rule) => rule.email)), aliases = await resolveRules(db, actor, rules);
    const emails = rules.filter((rule) => classified(rule.email, candidates.get(rule.email) ?? [], rule, aliases).linked_person?.public_id === person.public_id).map((rule) => rule.email);
    const rows: Array<{ message_id: string; received_at: number; facts: string }> = (await db.prepare(`SELECT i.message_id,i.received_at,i.facts FROM provider_gmail_index i WHERE i.connection_id=? AND i.generation=? AND i.received_at>=?
      AND (? IS NULL OR i.received_at<? OR (i.received_at=? AND i.message_id>?))
      AND EXISTS(SELECT 1 FROM provider_gmail_participants p WHERE p.connection_id=i.connection_id AND p.generation=i.generation AND p.message_id=i.message_id AND p.email IN(SELECT value FROM json_each(?)))
      ORDER BY i.received_at DESC,i.message_id LIMIT 51`).bind(id, s.resource.active_generation, s.window, cursor?.at ?? null, cursor?.at ?? null, cursor?.at ?? null, cursor?.id ?? '', JSON.stringify(emails))
      .all<{ message_id: string; received_at: number; facts: string }>()).results;
    more = rows.length > 50;
    messages = rows.slice(0, 50).map((row) => { const facts = JSON.parse(row.facts) as GmailPersonContext['messages'][number]['facts'];
      return { facts, linked_addresses: facts.participants.filter((participant) => emails.includes(participant.email)).map((participant) => participant.email) }; });
  }
  await fence(db, actor, s);
  const last = messages.at(-1)?.facts;
  return { ...publicScope(s), person, messages, more, next: more && last ? JSON.stringify({ at: last.received_at, id: last.id }) : null };
}
