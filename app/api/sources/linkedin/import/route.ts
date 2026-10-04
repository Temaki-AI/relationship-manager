import { handleLocalLinkedInImport } from '@/lib/linkedin-import-route';
export async function POST(request: Request) { return handleLocalLinkedInImport(request); }
