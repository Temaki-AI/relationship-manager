import { readJsonBody, RequestBodyError } from '@/lib/request-body';

export async function readCloudObject(request: Request): Promise<Record<string, unknown>> {
  const body = await readJsonBody(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestBodyError('Request body must be a JSON object.', 400);
  }
  return body as Record<string, unknown>;
}
