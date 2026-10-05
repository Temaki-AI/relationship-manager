import type { D1Database } from '@cloudflare/workers-types';

export const CLOUD_READINESS_MIGRATION = '0045_google_gmail_consent.sql';

export async function getCloudReadinessReport(
  db: Pick<D1Database, 'prepare'>,
  environment: Record<string, string | undefined>
) {
  const migration = await db.prepare('SELECT name FROM d1_migrations WHERE name = ? LIMIT 1')
    .bind(CLOUD_READINESS_MIGRATION).first<{ name: string }>();
  const authenticationConfigured = [
    'BETTER_AUTH_URL', 'BETTER_AUTH_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
  ].every((name) => Boolean(environment[name]?.trim()));
  const schemaCurrent = migration?.name === CLOUD_READINESS_MIGRATION;
  const ready = authenticationConfigured && schemaCurrent;

  return {
    status: ready ? 'ok' : 'unavailable',
    ready,
    checks: {
      authentication: authenticationConfigured ? 'google' : 'misconfigured',
      database: 'ok',
      schema: schemaCurrent ? 'current' : 'incompatible',
      backup: environment.CLOUD_AUTOMATIC_BACKUP_ENABLED === 'true' ? 'enabled' : 'disabled',
    },
  };
}
