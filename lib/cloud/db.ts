import { getCloudflareContext } from '@opennextjs/cloudflare';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

export function getCloudDb() {
  const { env } = getCloudflareContext();
  return drizzle(env.DB, { schema });
}

export function getPrivateAssetsBucket() {
  return getCloudflareContext().env.PRIVATE_ASSETS;
}
