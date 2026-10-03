export const DEFAULT_MAX_JSON_BODY_BYTES = 256 * 1024;
export const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

type RequestBodyOptions = {
  maximumBytes?: number;
  sizeLimitMessage?: string;
};

export class RequestBodyError extends Error {
  readonly status: 400 | 413;

  constructor(message: string, status: 400 | 413) {
    super(message);
    this.name = 'RequestBodyError';
    this.status = status;
  }
}

function getMaximumBytes(options: RequestBodyOptions): number {
  const maximumBytes = options.maximumBytes ?? DEFAULT_MAX_JSON_BODY_BYTES;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError('Request body limit must be a positive integer.');
  }
  return maximumBytes;
}

function getSizeLimitMessage(maximumBytes: number, configured?: string): string {
  if (configured) return configured;
  const kilobytes = Math.ceil(maximumBytes / 1024);
  return `Request body exceeds the ${kilobytes.toLocaleString()} KB limit.`;
}

function getDeclaredLength(request: Request): number | null {
  const value = request.headers.get('content-length');
  if (!value || !/^\d+$/.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : null;
}

async function readRequestBodyBytes(
  request: Request,
  options: RequestBodyOptions = {}
): Promise<Uint8Array> {
  const maximumBytes = getMaximumBytes(options);
  const sizeLimitMessage = getSizeLimitMessage(maximumBytes, options.sizeLimitMessage);
  const declaredLength = getDeclaredLength(request);
  if (declaredLength !== null && declaredLength > maximumBytes) {
    throw new RequestBodyError(sizeLimitMessage, 413);
  }

  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RequestBodyError(sizeLimitMessage, 413);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readJsonBody<T = unknown>(
  request: Request,
  options: RequestBodyOptions = {}
): Promise<T> {
  const bytes = await readRequestBodyBytes(request, options);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new RequestBodyError('Request body must be valid UTF-8.', 400);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new RequestBodyError('Valid JSON is required.', 400);
  }
}

export async function readFormDataBody(
  request: Request,
  options: RequestBodyOptions
): Promise<FormData> {
  const contentType = request.headers.get('content-type');
  if (!contentType?.toLowerCase().startsWith('multipart/form-data')) {
    throw new RequestBodyError('Valid multipart form data is required.', 400);
  }

  const bytes = await readRequestBodyBytes(request, options);
  const headers = new Headers(request.headers);
  headers.set('content-length', String(bytes.byteLength));
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);

  try {
    return await new Request(request.url, {
      method: request.method,
      headers,
      body,
    }).formData();
  } catch {
    throw new RequestBodyError('Valid multipart form data is required.', 400);
  }
}
