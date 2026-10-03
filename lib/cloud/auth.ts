import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth/minimal';
import { eq } from 'drizzle-orm';
import { getCloudDb } from './db';
import {
  accounts,
  sessions,
  users,
  verifications,
  workspaceMembers,
  workspaces,
} from './schema';

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be configured for Google authentication.`);
  return value;
}

export function isGoogleAuthEnabled(): boolean {
  return process.env.AUTH_MODE === 'google';
}

export function getCloudAuth() {
  const db = getCloudDb();

  return betterAuth({
    appName: 'Everclose CRM',
    baseURL: requiredEnvironment('BETTER_AUTH_URL'),
    secret: requiredEnvironment('BETTER_AUTH_SECRET'),
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
      },
    }),
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: {
        clientId: requiredEnvironment('GOOGLE_CLIENT_ID'),
        clientSecret: requiredEnvironment('GOOGLE_CLIENT_SECRET'),
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            const workspaceId = user.id;
            const existing = await db.select({ id: workspaces.id })
              .from(workspaces)
              .where(eq(workspaces.id, workspaceId))
              .limit(1);
            if (existing.length === 0) {
              await db.insert(workspaces).values({
                id: workspaceId,
                name: `${user.name || 'My'}'s workspace`,
              });
            }
            await db.insert(workspaceMembers).values({
              workspaceId,
              userId: user.id,
              role: 'owner',
            }).onConflictDoNothing();
          },
        },
      },
    },
    advanced: {
      useSecureCookies: process.env.NODE_ENV === 'production',
    },
  });
}
