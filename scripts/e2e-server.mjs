import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const standaloneRoot = join(projectRoot, '.next', 'standalone');
const serverPath = join(standaloneRoot, 'server.js');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'bonds-e2e-'));
const port = process.env.BONDS_E2E_PORT || '3111';

const server = spawn(process.execPath, [serverPath], {
  cwd: standaloneRoot,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    HOSTNAME: '127.0.0.1',
    PORT: port,
    CRM_PASSWORD: 'bonds-e2e-account-password',
    CRM_SESSION_SECRET: 'bonds-e2e-session-secret-123456789',
    CRM_DATABASE_PATH: join(temporaryRoot, 'relationships.db'),
    CRM_BACKUP_DIRECTORY: join(temporaryRoot, 'backups'),
    CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS: '24',
    SEED_DEMO_DATA: 'true',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

let stopping = false;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function stop(exitCode) {
  if (stopping) return;
  stopping = true;

  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([once(server, 'exit'), delay(5_000)]);
    if (server.exitCode === null) {
      server.kill('SIGKILL');
      await once(server, 'exit');
    }
  }

  await rm(temporaryRoot, { recursive: true, force: true });
  process.exit(exitCode);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => void stop(0));
}

server.once('error', (error) => {
  console.error(error);
  void stop(1);
});

server.once('exit', (code) => {
  if (!stopping) void stop(code ?? 1);
});
