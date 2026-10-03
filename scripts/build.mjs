import { spawn } from 'node:child_process';
import { access, cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const nextBinary = join(projectRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
const standaloneRoot = join(projectRoot, '.next', 'standalone');

async function runNextBuild(temporaryRoot) {
  const child = spawn(process.execPath, [nextBinary, 'build'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CRM_PASSWORD: 'build-only-password-not-for-runtime',
      CRM_SESSION_SECRET: 'build-only-session-secret-not-for-runtime-123456789',
      CRM_API_TOKEN: '',
      CRM_DATABASE_PATH: join(temporaryRoot, 'relationships.db'),
      CRM_BACKUP_DIRECTORY: join(temporaryRoot, 'backups'),
      CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS: '0',
      SEED_DEMO_DATA: 'false',
    },
    stdio: 'inherit',
  });

  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Next.js build failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`));
    });
  });
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(absolutePath));
    else if (entry.isFile()) files.push(absolutePath);
  }
  return files;
}

async function assembleAndVerifyStandalone() {
  await access(join(standaloneRoot, 'server.js'));
  await cp(join(projectRoot, 'public'), join(standaloneRoot, 'public'), { recursive: true });
  await cp(
    join(projectRoot, '.next', 'static'),
    join(standaloneRoot, '.next', 'static'),
    { recursive: true }
  );

  const files = await listFiles(standaloneRoot);
  const forbidden = files.filter((file) => {
    const filename = basename(file);
    return filename === '.env'
      || filename.startsWith('.env.')
      || /\.db(?:-(?:wal|shm|journal))?$/i.test(filename);
  });
  if (forbidden.length > 0) {
    const paths = forbidden.map((file) => relative(projectRoot, file)).join('\n');
    throw new Error(`Standalone output contains private runtime data:\n${paths}`);
  }

  const hasNativeSqlite = files.some((file) => file.endsWith(join('better-sqlite3', 'build', 'Release', 'better_sqlite3.node')));
  if (!hasNativeSqlite) throw new Error('Standalone output is missing the native better-sqlite3 binary.');

  console.log('Verified standalone output: runtime assets present and no database or environment files included.');
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'bonds-build-'));
try {
  await runNextBuild(temporaryRoot);
  await assembleAndVerifyStandalone();
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
