import type { GmailChoices, GmailMessageFacts } from './gmail';

export type GmailCandidate = { public_id: string; id: number; name: string };
export type GmailMatchStatus = 'unmatched' | 'suggested' | 'ambiguous' | 'linked' | 'excluded' | 'needs_review';
export type GmailCorrespondent = {
  email: string; messages: number; latest_at: number; candidates: GmailCandidate[]; candidates_more: boolean;
  status: GmailMatchStatus; linked_person: GmailCandidate | null;
};
export type GmailMatchScope = {
  epoch: string; authorization_revision: number; settings_revision: number; generation: string | null;
  directory_revision: number; matching_revision: number; directory_ready: boolean;
};
export type GmailMatchPage = GmailMatchScope & {
  mode: GmailChoices['mode']; correspondents: GmailCorrespondent[]; more: boolean; next: string | null;
};
export type GmailMatchDecision = {
  operation_id: string; action: 'link' | 'exclude' | 'clear'; email: string; target_public_id: string | null;
  expected_epoch: string; expected_authorization_revision: number; expected_settings_revision: number;
  expected_generation: string; expected_directory_revision: number; expected_matching_revision: number;
};
export type GmailMatchReceipt = { operation_id: string; revision: number; action: GmailMatchDecision['action']; email: string; target_public_id: string | null };
export type GmailPersonContext = GmailMatchScope & {
  person: GmailCandidate; messages: Array<{ facts: GmailMessageFacts; linked_addresses: string[] }>; more: boolean; next: string | null;
};

/** A reviewed address remains attached only while its complete current candidate
 * set agrees with the reviewed set, after resolving genuine merge aliases.
 */
export function gmailMatchStatus(candidates: GmailCandidate[], more: boolean,
  rule: { action: 'link' | 'exclude'; target: string | null; basis: Array<string | null> } | null): GmailMatchStatus {
  if (rule?.action === 'exclude') return 'excluded';
  if (rule?.action === 'link') {
    if (!rule.target || more || rule.basis.some((id) => !id)) return 'needs_review';
    const current = candidates.map((candidate) => candidate.public_id).sort();
    const reviewed = [...new Set(rule.basis as string[])].sort();
    return current.includes(rule.target) && JSON.stringify(current) === JSON.stringify(reviewed) ? 'linked' : 'needs_review';
  }
  return more || candidates.length > 1 ? 'ambiguous' : candidates.length === 1 ? 'suggested' : 'unmatched';
}
