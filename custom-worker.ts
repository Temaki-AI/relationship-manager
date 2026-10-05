// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- The generated module may not exist during Next.js type checking.
// @ts-ignore: OpenNext generates this module after the Next.js build.
import handler from './.open-next/worker.js';
import { cleanupExpiredExportJobs } from './lib/cloud/export-jobs';
import { deliverReminderEmails } from './lib/cloud/reminder-email-delivery';
import { deliverBirthdayEmails } from './lib/cloud/birthday-email-delivery';
import { cleanupStaleCloudBackupArtifacts, runAutomaticCloudBackups } from './lib/cloud/automatic-backup';
import { cleanupStaleCloudSnapshotArtifacts } from './lib/cloud/snapshot-cleanup';
import { maintainProviderConnections } from './lib/cloud/provider-connections';
import { processGoogleContactsMessage, reconcileGoogleContactsDownloads } from './lib/cloud/google-contact-downloads';
import { processCalendarEventMessage, reconcileCalendarEventDownloads } from './lib/cloud/google-event-jobs';
import { pruneGmailCache } from './lib/cloud/google-gmail-downloads';
import type { ProviderEnvironment } from './lib/cloud/google-provider';
import { processCloudRestoreMessage, reconcileStalledCloudRestoreJobs,
  type RecoveryQueueDelivery } from './lib/cloud/large-recovery-queue';

const worker = {
  fetch: handler.fetch,
  async scheduled(_controller: unknown, env: CloudflareEnv) {
    const results = await Promise.allSettled([
      cleanupExpiredExportJobs(env.DB, env.PRIVATE_ASSETS),
      deliverReminderEmails(env.DB, env),
      deliverBirthdayEmails(env.DB, env),
      cleanupStaleCloudBackupArtifacts(env.DB, env.PRIVATE_ASSETS),
      cleanupStaleCloudSnapshotArtifacts(env.DB, env.PRIVATE_ASSETS),
      reconcileStalledCloudRestoreJobs(env.DB, env.LARGE_RECOVERY_QUEUE),
      env.CLOUD_AUTOMATIC_BACKUP_ENABLED === 'true'
        ? runAutomaticCloudBackups(env.DB, env.PRIVATE_ASSETS)
        : Promise.resolve({ claimed: 0, created: 0, failed: 0, oversized: 0 }),
      maintainProviderConnections(env.DB, { ...process.env, ...env } as unknown as ProviderEnvironment),
      reconcileGoogleContactsDownloads(env.DB, env.GOOGLE_CONTACTS_QUEUE, { ...process.env, ...env }),
      reconcileCalendarEventDownloads(env.DB, env.GOOGLE_CALENDAR_QUEUE, { ...process.env, ...env }),
      pruneGmailCache(env.DB),
    ]);
    const [cleanup, emails, birthdays, backupCleanup, snapshotCleanup, restoreReconciliation, automaticBackups, providerMaintenance, contactsDownloads, calendarDownloads, gmailRetention] = results;
    if (cleanup.status === 'fulfilled') console.info('cloud.export.retention', cleanup.value);
    if (emails.status === 'fulfilled') console.info('cloud.reminder.email', emails.value);
    if (birthdays.status === 'fulfilled') console.info('cloud.birthday.email', birthdays.value);
    if (backupCleanup.status === 'fulfilled') console.info('cloud.backup.cleanup', backupCleanup.value);
    if (snapshotCleanup.status === 'fulfilled') console.info('cloud.snapshot.cleanup', snapshotCleanup.value);
    if (restoreReconciliation.status === 'fulfilled') console.info('cloud.restore.reconciled', restoreReconciliation.value);
    if (automaticBackups.status === 'fulfilled') console.info('cloud.backup.automatic', automaticBackups.value);
    if (providerMaintenance.status === 'fulfilled') console.info('cloud.provider.maintenance', providerMaintenance.value);
    if (contactsDownloads.status === 'fulfilled') console.info('cloud.google_contacts.downloads', contactsDownloads.value);
    if (calendarDownloads.status === 'fulfilled') console.info('cloud.google_calendar.downloads', calendarDownloads.value);
    if (cleanup.status === 'rejected' || emails.status === 'rejected'
      || birthdays.status === 'rejected'
      || backupCleanup.status === 'rejected' || snapshotCleanup.status === 'rejected'
      || restoreReconciliation.status === 'rejected'
      || automaticBackups.status === 'rejected'
      || providerMaintenance.status === 'rejected'
      || contactsDownloads.status === 'rejected'
      || calendarDownloads.status === 'rejected'
      || gmailRetention.status === 'rejected'
      || (cleanup.status === 'fulfilled' && cleanup.value.failed)
      || (backupCleanup.status === 'fulfilled' && backupCleanup.value.failed)
      || (snapshotCleanup.status === 'fulfilled' && snapshotCleanup.value.failed)
      || (automaticBackups.status === 'fulfilled' && automaticBackups.value.failed)) {
      throw new Error('One or more scheduled maintenance tasks failed.');
    }
  },
  async queue(batch: { messages: readonly RecoveryQueueDelivery[] }, env: CloudflareEnv) {
    for (const message of batch.messages) {
      if (message.body && typeof message.body === 'object' && 'kind' in message.body && message.body.kind === 'google-contacts') await processGoogleContactsMessage(message, env);
      else if (message.body && typeof message.body === 'object' && 'kind' in message.body && message.body.kind === 'google-calendar') await processCalendarEventMessage(message, env);
      else await processCloudRestoreMessage(message, env);
    }
  },
};

export default worker;
