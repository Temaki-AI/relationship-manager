import { buildLocalEnrichment } from '@/lib/enrichment';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';

export async function handleCloudEnrich(request: Request): Promise<Response> {
  try {
    const body = await readJsonBody<unknown>(request);
    const email = body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>).email : undefined;
    const enrichment = buildLocalEnrichment(email);
    return enrichment
      ? Response.json({ success: true, ...enrichment })
      : Response.json({ error: 'Valid email required' }, { status: 400 });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error('cloud.enrichment.failed', { errorName: error instanceof Error ? error.name : 'unknown' });
    return Response.json({ error: 'Enrichment failed' }, { status: 500 });
  }
}
