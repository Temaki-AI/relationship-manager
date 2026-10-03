const exactPaths = new Set([
  '/api/calendar',
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
  const resourcePath = /^\/api\/(?:interactions|plans|reminders|groups)\/\d+$/u.test(pathname);
  const contactPath = /^\/api\/contacts\/\d+(?:\/(?:children|relationships)(?:\/\d+)?|\/photo)?$/u.test(pathname);
  const backupPath = /^\/api\/settings\/backups\/bonds-cloud-[A-Za-z0-9.-]+\.json$/u.test(pathname);
  const importPath = /^\/api\/import\/jobs\/[0-9a-f-]{36}(?:\/source)?$/iu.test(pathname);
  const exportPath = /^\/api\/export\/jobs\/[0-9a-f-]{36}(?:\/download)?$/iu.test(pathname);
  const largeRecoveryPath = /^\/api\/settings\/large-recovery\/[0-9a-f-]{36}(?:\/(?:step|apply|rollback|pause|resume|cancel))?$/iu.test(pathname);
  if (exactPaths.has(pathname) || resourcePath || contactPath || backupPath || importPath || exportPath || largeRecoveryPath) {
    return `/api/cloud${pathname.slice('/api'.length)}`;
  }
  return null;
}
