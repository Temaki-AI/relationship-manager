export async function handleCloudExport(_workspaceId: string, format: 'csv' | 'vcard'): Promise<Response> {
  return Response.json({
    error: `Direct ${format === 'csv' ? 'CSV' : 'vCard'} downloads have moved to Contact exports. Prepare a resumable export from People instead. No partial file was downloaded.`,
  }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
}
