type Environment = Record<string, string | undefined>;
type HeaderSource = Headers | Record<string, string | string[] | undefined>;
type LogLevel = 'info' | 'warn' | 'error';
type ConfiguredLogLevel = LogLevel | 'silent';
type LogValue = string | number | boolean | null | undefined;
type LogFields = Record<string, LogValue>;

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_PATTERN = /^[a-z][a-z0-9_.-]{2,80}$/;
const SAFE_ERROR_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const LEVEL_PRIORITY: Record<ConfiguredLogLevel, number> = {
  info: 0,
  warn: 1,
  error: 2,
  silent: 3,
};
const ALLOWED_FIELDS = new Set([
  'request_id',
  'method',
  'route',
  'route_type',
  'router_kind',
  'render_source',
  'runtime',
  'error_name',
  'error_code',
  'error_digest',
  'backup_state',
  'operation',
  'status_code',
]);

export type StructuredLogRecord = {
  timestamp: string;
  level: LogLevel;
  event: string;
  [key: string]: string | number | boolean | null;
};

function sanitizeString(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 256);
}

function sanitizeField(key: string, value: Exclude<LogValue, undefined>): string | number | boolean | null {
  if (typeof value !== 'string') return value;
  const sanitized = sanitizeString(value);
  if (key === 'route') return sanitized.split(/[?#]/, 1)[0].slice(0, 160);
  if (key === 'method') return sanitized.toUpperCase().slice(0, 12);
  return sanitized;
}

function getHeader(source: HeaderSource | undefined, name: string): string | null {
  if (!source) return null;
  if (source instanceof Headers) return source.get(name);
  const value = source[name] ?? source[name.toLowerCase()];
  return Array.isArray(value) ? value[0] || null : value || null;
}

function getErrorFields(error: unknown): LogFields {
  if (!error || typeof error !== 'object') {
    return { error_name: typeof error === 'string' ? 'StringError' : 'UnknownError' };
  }

  const value = error as { name?: unknown; code?: unknown; digest?: unknown };
  const name = typeof value.name === 'string' ? sanitizeString(value.name) : 'UnknownError';
  const fields: LogFields = { error_name: name || 'UnknownError' };
  if (typeof value.code === 'string' && SAFE_ERROR_CODE_PATTERN.test(value.code)) {
    fields.error_code = value.code;
  }
  if (typeof value.digest === 'string' && SAFE_ERROR_CODE_PATTERN.test(value.digest)) {
    fields.error_digest = value.digest;
  }
  return fields;
}

export function getConfiguredLogLevel(environment: Environment = process.env): ConfiguredLogLevel {
  const configured = environment.CRM_LOG_LEVEL?.trim().toLowerCase();
  if (configured === 'info' || configured === 'warn' || configured === 'error' || configured === 'silent') {
    return configured;
  }
  return 'info';
}

export function getRequestId(source: HeaderSource | undefined): string | null {
  const value = getHeader(source, 'x-request-id');
  return value && REQUEST_ID_PATTERN.test(value) ? value.toLowerCase() : null;
}

export function createStructuredLogRecord(
  level: LogLevel,
  event: string,
  fields: LogFields = {},
  now = new Date()
): StructuredLogRecord {
  const record: StructuredLogRecord = {
    timestamp: now.toISOString(),
    level,
    event: EVENT_PATTERN.test(event) ? event : 'application.invalid_event',
  };

  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_FIELDS.has(key) || value === undefined) continue;
    record[key] = sanitizeField(key, value);
  }
  return record;
}

function writeLog(level: LogLevel, event: string, fields: LogFields): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[getConfiguredLogLevel()]) return;
  const line = JSON.stringify(createStructuredLogRecord(level, event, fields));
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}

export function logInfo(event: string, fields: LogFields = {}): void {
  writeLog('info', event, fields);
}

export function logWarning(event: string, fields: LogFields = {}): void {
  writeLog('warn', event, fields);
}

export function logError(
  event: string,
  error: unknown,
  headers?: HeaderSource,
  fields: LogFields = {}
): void {
  const requestId = getRequestId(headers);
  writeLog('error', event, {
    ...fields,
    ...getErrorFields(error),
    request_id: requestId || undefined,
  });
}

export function logRouteError(
  event: string,
  error: unknown,
  request: Request,
  route: string,
  statusCode = 500
): void {
  logError(event, error, request.headers, {
    method: request.method,
    route,
    status_code: statusCode,
  });
}
