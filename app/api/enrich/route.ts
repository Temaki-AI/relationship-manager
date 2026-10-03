import { NextResponse } from 'next/server';
import { buildLocalEnrichment } from '@/lib/enrichment';
import { readJsonBody, RequestBodyError } from '@/lib/request-body';
import { logRouteError } from '@/lib/observability';

export async function POST(request: Request) {
  try {
    const body = await readJsonBody<unknown>(request);
    const email = body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>).email : undefined;
    const enrichment = buildLocalEnrichment(email);

    if (!enrichment) {
      return NextResponse.json({ error: 'Valid email required' }, { status: 400 });
    }

    return NextResponse.json({ 
      success: true,
      ...enrichment,
    });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logRouteError('enrichment.failed', error, request, '/api/enrich');
    return NextResponse.json({ error: 'Enrichment failed' }, { status: 500 });
  }
}
