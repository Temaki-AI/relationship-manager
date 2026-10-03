const DEFAULT_MAX_CONTACT_IMPORT_MEGABYTES = 10;

export const MAX_CONTACT_IMPORT_RECORDS = 25_000;

export function getMaxContactImportMegabytes(): number {
  const configured = process.env.CRM_MAX_CONTACT_IMPORT_MB
    || process.env.CRM_MAX_CSV_IMPORT_MB;
  const parsed = Number(configured);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_MAX_CONTACT_IMPORT_MEGABYTES;
  return Math.min(parsed, 100);
}

export function getMaxContactImportBytes(): number {
  return getMaxContactImportMegabytes() * 1024 * 1024;
}
