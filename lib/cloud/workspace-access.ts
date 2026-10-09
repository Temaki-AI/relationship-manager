export function cloudWorkspaceMaintenanceResponse(lifecycle: string, path: string[], method: string): Response | null {
  if (lifecycle === 'active') return null;
  const route = path.join('/');
  if (path[0] === 'connections' && (method === 'GET' && route === 'connections' || method === 'DELETE' && path.length === 2)) return null;
  if (path[0] === 'v1' && path[1] === 'devices' && (method === 'GET' || method === 'DELETE')) return null;
  if ((lifecycle === 'erasing' || lifecycle === 'restoring')
    && route === 'settings/backups' && method === 'GET') return null;
  if (lifecycle === 'restoring' && path[0] === 'settings' && path[1] === 'large-recovery'
    && (method === 'GET' || method === 'POST')) return null;
  if (lifecycle === 'erasing' && route === 'settings/erase' && method === 'POST') return null;
  const message = lifecycle === 'erasing'
    ? 'Workspace erasure is in progress. Open Data & recovery to continue it.'
    : 'Workspace recovery is in progress. Contact support before making changes.';
  return Response.json({ error: message, lifecycle }, {
    status: 423,
    headers: { 'Cache-Control': 'no-store', 'Retry-After': '15' },
  });
}
