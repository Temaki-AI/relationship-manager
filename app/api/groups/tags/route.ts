import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { listTagSummaries } from '@/lib/contact-directory';
import { logRouteError } from '@/lib/observability';

export function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    return NextResponse.json(listTagSummaries(db, {
      page: searchParams.get('page'),
      pageSize: searchParams.get('pageSize'),
    }));
  } catch (error) {
    logRouteError('tag_groups.load_failed', error, request, '/api/groups/tags');
    return NextResponse.json({ error: 'Failed to fetch groups.' }, { status: 500 });
  }
}
