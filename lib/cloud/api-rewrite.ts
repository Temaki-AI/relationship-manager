const exactPaths = new Set([
  '/api/v1/gmail-context',
  '/api/v1/today-snoozes',
  '/api/v1/calendar-reservations',
  '/api/v1/sync/bootstrap',
  '/api/v1/sync/pull',
  '/api/v1/sync/push',
  '/api/v2/sync/bootstrap',
  '/api/v2/sync/pull',
  '/api/v2/sync/push',
  '/api/v4/sync/bootstrap',
  '/api/v4/sync/pull',
  '/api/v4/sync/push',
  '/api/v3/sync/bootstrap',
  '/api/v3/sync/pull',
  '/api/v3/sync/push',
  '/api/v1/devices',
  '/api/v1/devices/authorize',
  '/api/v1/devices/session',
  '/api/v1/device-sources/push',
  '/api/v1/calendar-event-links/push',
  '/api/calendar',
  '/api/calendar/events',
  '/api/contacts',
  '/api/contacts/bulk',
  '/api/contacts/duplicates',
  '/api/enrich',
  '/api/groups',
  '/api/groups/tags',
  '/api/groups/tags/contacts',
  '/api/export/csv',
  '/api/export/vcard',
  '/api/export/jobs',
  '/api/integrations',
  '/api/connections',
  '/api/connections/google/authorize',
  '/api/connections/google/callback',
  '/api/sources/linkedin',
  '/api/sources/context',
  '/api/sources/linkedin/import',
  '/api/sources/linkedin/import/preview',
  '/api/import/csv',
  '/api/import/vcard',
  '/api/import/jobs',
  '/api/intelligence/overview',
  '/api/interactions',
  '/api/plans',
  '/api/reminders',
  '/api/reminders/email-preferences',
  '/api/smart-lists',
  '/api/stats',
  '/api/today/snooze',
  '/api/settings/backups',
  '/api/settings/restore',
  '/api/settings/large-recovery',
  '/api/settings/erase',
]);

export function getCloudApiRewrite(pathname: string): string | null {
  const gmailPath = /^\/api\/connections\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/gmail\/(?:settings|schedule|messages|matches(?:\/directory)?|people\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|downloads(?:\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\/step)?)?)$/u.test(pathname);
  const resourcePath = /^\/api\/(?:interactions|plans|reminders|groups)\/\d+$/u.test(pathname);
  const devicePath = /^\/api\/v1\/devices\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(pathname);
  const photoPath = /^\/api\/v1\/contact-photos\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(pathname);
  const contactPath = /^\/api\/contacts\/\d+(?:\/(?:children|relationships)(?:\/\d+)?|\/photo)?$/u.test(pathname);
  const sourcePath = /^\/api\/contacts\/\d+\/(?:sources|provider-sources|device-sources)(?:\/[0-9a-f-]{36})?$/u.test(pathname);
  const connectionPath = /^\/api\/connections\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\/gmail|\/plan-publications\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\/step)?|\/owned-calendar(?:\/step)?|\/contacts(?:\/(?:step|import-preview|import|schedule))?|\/calendars(?:\/(?:step|selection|events(?:\/(?:step|link-preview|link|schedule))?))?)?$/u.test(pathname);
  const eventPath = /^\/api\/calendar\/events\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(pathname);
  const backupPath = /^\/api\/settings\/backups\/bonds-cloud-[A-Za-z0-9.-]+\.json$/u.test(pathname);
  const importPath = /^\/api\/import\/jobs\/[0-9a-f-]{36}(?:\/source)?$/iu.test(pathname);
  const exportPath = /^\/api\/export\/jobs\/[0-9a-f-]{36}(?:\/download)?$/iu.test(pathname);
  const largeRecoveryPath = /^\/api\/settings\/large-recovery\/[0-9a-f-]{36}(?:\/(?:step|apply|rollback|pause|resume|cancel))?$/iu.test(pathname);
  if (exactPaths.has(pathname) || gmailPath || photoPath || eventPath || connectionPath || devicePath || resourcePath || contactPath || sourcePath || backupPath || importPath || exportPath || largeRecoveryPath) {
    return `/api/cloud${pathname.slice('/api'.length)}`;
  }
  return null;
}
