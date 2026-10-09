import { handleLocalSourceRequest } from '@/lib/contact-source-route';
export async function POST(request: Request) { return handleLocalSourceRequest(request); }
