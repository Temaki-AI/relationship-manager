export const IMPORT_ROW_STATES = ['pending', 'ready', 'review', 'invalid', 'skipped', 'imported'] as const;
export type ImportRowState = typeof IMPORT_ROW_STATES[number];
export type ImportJobState = 'preparing' | 'review' | 'importing' | 'complete' | 'cancelled';
export const IMPORT_STATE_LABELS: Record<ImportRowState, string> = {
  pending: 'Not checked', ready: 'Ready', review: 'Needs a decision',
  invalid: 'Invalid', skipped: 'Skipped', imported: 'Imported',
};
export type ImportReportRow = {
  row_number: number; name: string; email: string | null; phone: string | null;
  birthday: string | null; state: ImportRowState; message: string | null; contact_id: number | null;
  matches: Array<{ id: number; name: string }>;
  fileMatches: Array<{ row: number; name: string }>;
};
export type ImportReport = {
  job: { id: string; filename: string; format: 'csv' | 'vcard'; state: ImportJobState; total: number; createdAt: string; sourceBytes: number };
  counts: Record<ImportRowState, number>;
  rows: ImportReportRow[];
  pagination: { page: number; total: number; totalPages: number; pageSize: number };
  retention: string;
};
