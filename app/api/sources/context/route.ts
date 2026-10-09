import { handleLocalSourceRequest } from '@/lib/contact-source-route';
export async function GET(request: Request) { return handleLocalSourceRequest(request); }
