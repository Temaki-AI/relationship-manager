import { handleLocalSourceRequest } from '@/lib/contact-source-route';
async function handle(request: Request, context: { params: Promise<{ id: string; source: string }> }) {
  const { id, source } = await context.params;
  return handleLocalSourceRequest(request, id, source);
}
export const PATCH = handle;
export const DELETE = handle;
