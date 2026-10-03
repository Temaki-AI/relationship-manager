import { toNextJsHandler } from 'better-auth/next-js';
import { getCloudAuth } from '@/lib/cloud/auth';

export const dynamic = 'force-dynamic';

const handler = (request: Request) => getCloudAuth().handler(request);

export const { GET, POST, PATCH, PUT, DELETE } = toNextJsHandler(handler);
