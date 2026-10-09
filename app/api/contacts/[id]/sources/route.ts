import { handleLocalSourceRequest } from '@/lib/contact-source-route';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleLocalSourceRequest(request, (await context.params).id);
}
