import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const DEVELOPMENT_ENV_FILE = '.env.development.local';
export const DEVELOPMENT_URL = 'http://localhost:3100';
export const DEVELOPMENT_CONFIG = 'wrangler.local.jsonc';
export const DEVELOPMENT_STORAGE = '.wrangler/everclose-local';

export async function ensureDevelopmentEnvironment(root = projectRoot) {
  const filename = join(root, DEVELOPMENT_ENV_FILE);
  const template = await readFile(join(root, '.env.development.example'), 'utf8');
  try {
    const configured = template.replace('__GENERATE_LOCAL_SECRET__', randomBytes(32).toString('hex'))
      .replace('__GENERATE_CONNECTOR_KEYRING__', JSON.stringify({ active: 'local-v1', keys: { 'local-v1': randomBytes(32).toString('base64url') } }));
    await writeFile(filename, configured, {
      flag: 'wx', mode: 0o600,
    });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  await chmod(filename, 0o600);
  return parseEnv(await readFile(filename, 'utf8'));
}

export function cloudDevelopmentEnvironment(values, inherited = process.env) {
  return {
    ...inherited,
    ...values,
    NODE_ENV: 'development',
    EVERCLOSE_DEVELOPMENT: 'cloud',
    AUTH_MODE: 'google',
    NEXT_PUBLIC_AUTH_MODE: 'google',
    BETTER_AUTH_URL: DEVELOPMENT_URL,
    SEED_DEMO_DATA: 'false',
    CLOUD_AUTOMATIC_BACKUP_ENABLED: 'false',
    CLOUD_LARGE_RECOVERY_ENABLED: 'false',
    EMAIL_DELIVERY_ENABLED: 'false',
    // Wrangler bindings come from the explicit local config, not another .env.
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
    WRANGLER_SEND_METRICS: 'false',
  };
}

export function developmentConfigurationProblems(environment) {
  const problems = [];
  for (const name of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']) {
    if (!environment[name]?.trim()) problems.push(`${name} is missing`);
  }
  const secret = environment.BETTER_AUTH_SECRET || '';
  if (secret.length < 32 || secret === '__GENERATE_LOCAL_SECRET__') {
    problems.push('BETTER_AUTH_SECRET must be an independent random secret of at least 32 characters');
  }
  return problems;
}

export async function assertIsolatedConfiguration(root = projectRoot) {
  const local = JSON.parse(await readFile(join(root, DEVELOPMENT_CONFIG), 'utf8'));
  const production = JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8'));
  if (local.name === production.name || local.account_id || local.routes?.length || local.workers_dev !== false) {
    throw new Error('Local development must not target the production Worker or its domains.');
  }
  for (const key of ['d1_databases', 'r2_buckets']) {
    for (const binding of local[key] || []) {
      if (binding.remote !== false || (production[key] || []).some((live) =>
        key === 'd1_databases'
          ? live.database_id === binding.database_id || live.database_name === binding.database_name
          : live.bucket_name === binding.bucket_name)) {
        throw new Error(`Local ${binding.binding} must use isolated simulated storage.`);
      }
    }
  }
  if (local.services?.some((service) => service.service !== local.name || service.remote !== false)) {
    throw new Error('Local service bindings must not call a deployed Worker.');
  }
}

async function run(binary, args, env) {
  const child = spawn(process.execPath, [join(projectRoot, 'node_modules', binary), ...args], {
    cwd: projectRoot, env, stdio: 'inherit',
  });
  const forward = (signal) => child.kill(signal);
  const onInterrupt = () => forward('SIGINT');
  const onTerminate = () => forward('SIGTERM');
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  try {
    await new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 || signal === 'SIGINT' || signal === 'SIGTERM'
        ? accept() : reject(new Error(`${binary} exited with ${signal || code}.`)));
    });
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
}

async function migrate(env) {
  await run('wrangler/bin/wrangler.js', [
    'd1', 'migrations', 'apply', 'DB', '--local', '--config', DEVELOPMENT_CONFIG,
    '--persist-to', DEVELOPMENT_STORAGE,
  ], env);
}

async function main(action) {
  if (!['setup', 'check', 'cloud', 'local', 'preview'].includes(action)) {
    throw new Error('Use setup, check, cloud, local, or preview.');
  }
  if (action === 'local') {
    console.log('SQLite development: separate local contacts; Google/cloud workflows are disabled.');
    await run('next/dist/bin/next', ['dev', '-p', '3100', '--hostname', '127.0.0.1'], {
      ...process.env, NODE_ENV: 'development', EVERCLOSE_DEVELOPMENT: 'local',
      AUTH_MODE: '', NEXT_PUBLIC_AUTH_MODE: '', SEED_DEMO_DATA: 'false',
    });
    return;
  }
  await assertIsolatedConfiguration();
  const environment = cloudDevelopmentEnvironment(await ensureDevelopmentEnvironment());
  const problems = developmentConfigurationProblems(environment);
  if (action === 'setup') {
    await migrate(environment);
    console.log(`Local D1 schema is current. Secrets file: ${DEVELOPMENT_ENV_FILE} (owner-only).`);
    if (problems.length) {
      console.log(`Google sign-in still needs configuration:\n- ${problems.join('\n- ')}`);
      console.log(`Authorized Google redirect URI: ${DEVELOPMENT_URL}/api/auth/callback/google`);
    } else console.log('Google credential values are present. Run npm run dev and verify sign-in.');
    return;
  }
  if (problems.length) {
    throw new Error(`${problems.join('; ')}. Fill ${DEVELOPMENT_ENV_FILE}, then retry.\n` +
      `Google redirect URI: ${DEVELOPMENT_URL}/api/auth/callback/google\n` +
      'No fallback to unauthenticated SQLite or demo contacts was started.');
  }
  if (action === 'check') {
    console.log('Local bindings are isolated and Google credential values are present. OAuth must still be tested in a browser.');
    return;
  }
  await migrate(environment);
  console.log(`Cloud development: ${DEVELOPMENT_URL} — Google sign-in, local D1/R2, no production contacts.`);
  if (action === 'cloud') {
    await run('next/dist/bin/next', ['dev', '-p', '3100', '--hostname', '127.0.0.1'], environment);
  } else {
    const previewEnvironment = { ...environment, NODE_ENV: 'production' };
    await run('@opennextjs/cloudflare/dist/cli/index.js', ['build', '--config', DEVELOPMENT_CONFIG], previewEnvironment);
    await run('@opennextjs/cloudflare/dist/cli/index.js', [
      'preview', '--config', DEVELOPMENT_CONFIG, '--ip', '127.0.0.1', '--port', '3100',
      '--local', '--persist-to', DEVELOPMENT_STORAGE, '--env-file', DEVELOPMENT_ENV_FILE,
    ], previewEnvironment);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
