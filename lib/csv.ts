export const MAX_CSV_IMPORT_ROWS = 25_000;

export class CSVValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CSVValidationError';
  }
}

export function parseCSV(text: string): string[][] {
  const records: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"' && text[i + 1] === '"') {
        currentField += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        currentField += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      currentRow.push(currentField);
      currentField = '';
    } else if (char === '\n') {
      currentRow.push(currentField);
      if (currentRow.some((field) => field.trim() !== '')) {
        records.push(currentRow);
      }
      currentRow = [];
      currentField = '';
    } else if (char !== '\r') {
      currentField += char;
    }
  }

  if (inQuotes) {
    throw new CSVValidationError('CSV contains an unterminated quoted field.');
  }

  currentRow.push(currentField);
  if (currentRow.some((field) => field.trim() !== '')) {
    records.push(currentRow);
  }

  return records;
}

export function escapeCSVField(value: string): string {
  const firstVisibleCharacter = value.trimStart()[0];
  const spreadsheetSafeValue = firstVisibleCharacter && '=+-@'.includes(firstVisibleCharacter)
    ? `'${value}`
    : value;

  if (
    spreadsheetSafeValue.includes(',')
    || spreadsheetSafeValue.includes('"')
    || spreadsheetSafeValue.includes('\n')
    || spreadsheetSafeValue.includes('\r')
  ) {
    return `"${spreadsheetSafeValue.replace(/"/g, '""')}"`;
  }
  return spreadsheetSafeValue;
}

export function normalizeImportedFrequency(value: string | undefined): number {
  const parsed = value ? parseInt(value, 10) : 14;
  if (Number.isNaN(parsed) || parsed < 1 || parsed > 3_650) {
    return 14;
  }
  return parsed;
}

export function parseImportedTagsValue(value: string): string | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return JSON.stringify(parsed.filter((item): item is string => typeof item === 'string'));
    }
  } catch {
    return JSON.stringify(
      value
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean)
    );
  }

  return null;
}

export function parseImportedGiftIdeasValue(value: string): string | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return JSON.stringify(parsed.filter((item): item is string => typeof item === 'string'));
    }
  } catch {
    return JSON.stringify(
      value
        .split('\n')
        .map((idea) => idea.trim())
        .filter(Boolean)
    );
  }

  return null;
}
