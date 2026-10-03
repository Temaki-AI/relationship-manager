export type EnrichedData = {
  company?: string;
  companyDomain?: string;
  source?: string;
  suggestedNotes?: string;
};

export type LocalEnrichmentResult = {
  data: EnrichedData;
  found: boolean;
};

const PERSONAL_EMAIL_DOMAINS = new Set([
  'aol.com',
  'gmail.com',
  'hotmail.com',
  'icloud.com',
  'live.com',
  'me.com',
  'msn.com',
  'outlook.com',
  'pm.me',
  'protonmail.com',
  'yahoo.com',
]);

function getEmailDomain(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().toLowerCase().match(/^[^@\s]+@([^@\s]+)$/);
  return match?.[1] ?? null;
}

function formatCompanyName(domain: string): string {
  return domain
    .split('.')[0]
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function buildLocalEnrichment(email: unknown): LocalEnrichmentResult | null {
  const domain = getEmailDomain(email);
  if (!domain) return null;

  if (PERSONAL_EMAIL_DOMAINS.has(domain)) {
    return { data: {}, found: false };
  }

  const company = formatCompanyName(domain);
  return {
    data: {
      company,
      companyDomain: domain,
      source: 'email-domain',
      suggestedNotes: `Company: ${company}`,
    },
    found: true,
  };
}
