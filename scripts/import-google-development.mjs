import { constants } from 'node:fs';
import { chmod, lstat, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { DEVELOPMENT_ENV_FILE, DEVELOPMENT_URL, GOOGLE_DEVELOPMENT_PREFIXES } from './development.mjs';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_FILE_BYTES = 64 * 1024;
const identity = /^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/;
const secret = /^[A-Za-z0-9_-]{8,1024}$/;
const project = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

async function boundedFile(filename, message) {
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error();
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const part = await handle.read(bytes, length, bytes.length - length, length);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    if (length > MAX_FILE_BYTES) throw new Error();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } catch { throw new Error(message); }
  finally { await handle?.close(); }
}

function clientConfiguration(text, purpose) {
  let web;
  try { web = JSON.parse(text).web; }
  catch { throw new Error('The credential file must be a valid Google Web application client export.'); }
  const callback = DEVELOPMENT_URL + (purpose === 'login'
    ? '/api/auth/callback/google' : '/api/connections/google/callback');
  if (!web || typeof web !== 'object' || Array.isArray(web)
    || typeof web.client_id !== 'string' || web.client_id.length > 512 || !identity.test(web.client_id)
    || typeof web.client_secret !== 'string' || !secret.test(web.client_secret)
    || typeof web.project_id !== 'string' || !project.test(web.project_id)) {
    throw new Error('The export needs a valid Web client ID, secret and Google project ID.');
  }
  if (web.auth_uri !== 'https://accounts.google.com/o/oauth2/auth'
    || web.token_uri !== 'https://oauth2.googleapis.com/token'
    || !Array.isArray(web.redirect_uris) || web.redirect_uris.length !== 1 || web.redirect_uris[0] !== callback
    || !Array.isArray(web.javascript_origins) || web.javascript_origins.length !== 1
    || web.javascript_origins[0] !== DEVELOPMENT_URL) {
    throw new Error(`Use a dedicated localhost client with origin ${DEVELOPMENT_URL} and only callback ${callback}.`);
  }
  return web;
}

function replaceValue(text, name, value) {
  const expression = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=.*$`, 'gm');
  const matches = [...text.matchAll(expression)];
  if (matches.length > 1) throw new Error('The local configuration contains duplicate credential keys. Resolve them before importing.');
  const line = `${name}=${JSON.stringify(value)}`;
  return matches.length ? text.replace(expression, () => line) : text + (text.endsWith('\n') ? '' : '\n') + line + '\n';
}

export async function importGoogleDevelopmentClient({ purpose, file, root = projectRoot }) {
  if (!Object.hasOwn(GOOGLE_DEVELOPMENT_PREFIXES, purpose) || typeof file !== 'string' || !file) {
    throw new Error('Choose --purpose login, contacts, calendar, calendar-publish or gmail and --file with the downloaded JSON path.');
  }
  const prefix = GOOGLE_DEVELOPMENT_PREFIXES[purpose];
  const web = clientConfiguration(await boundedFile(file, 'The Google credential export could not be read safely.'), purpose);
  const filename = join(root, DEVELOPMENT_ENV_FILE);
  const original = await boundedFile(filename, 'Run npm run setup:dev first; its local configuration must be a regular file.');
  let values;
  try { values = parseEnv(original); }
  catch { throw new Error('The local configuration is invalid. Correct it before importing credentials.'); }
  for (const [otherPurpose, otherPrefix] of Object.entries(GOOGLE_DEVELOPMENT_PREFIXES)) {
    if (otherPurpose === purpose) continue;
    if (values[`${otherPrefix}_CLIENT_ID`] === web.client_id) {
      throw new Error('Each Google purpose needs its own OAuth client. The selected client is already used by another purpose.');
    }
    if ((purpose === 'login' || otherPurpose === 'login')
      && values[`${otherPrefix}_PROJECT_ID`] === web.project_id) {
      throw new Error('Use separate Google projects for local sign-in and data connections.');
    }
  }
  if (purpose !== 'login' && (!values.GOOGLE_CLIENT_ID || !values.GOOGLE_PROJECT_ID)) {
    throw new Error('Import the local sign-in client first so its project can be kept separate from data connections.');
  }
  const updates = {
    [`${prefix}_CLIENT_ID`]: web.client_id,
    [`${prefix}_CLIENT_SECRET`]: web.client_secret,
    [`${prefix}_PROJECT_ID`]: web.project_id,
  };
  let next = original;
  for (const [name, value] of Object.entries(updates)) next = replaceValue(next, name, value);
  let parsed;
  try { parsed = parseEnv(next); }
  catch { throw new Error('The configuration cannot be updated safely. Resolve its formatting first.'); }
  if (Object.entries(updates).some(([name, value]) => parsed[name] !== value)
    || Object.entries(values).some(([name, value]) => !Object.hasOwn(updates, name) && parsed[name] !== value)) {
    throw new Error('The configuration cannot be updated without changing unrelated values. Resolve its formatting first.');
  }
  if (next === original) { await chmod(filename, 0o600); return { purpose, changed: false }; }
  const temporary = `${filename}.import-${randomUUID()}`;
  try {
    await writeFile(temporary, next, { flag: 'wx', mode: 0o600 });
    if (!(await lstat(filename)).isFile() || await readFile(filename, 'utf8') !== original) {
      throw new Error('The local configuration changed during import. Retry after saving your changes.');
    }
    await rename(temporary, filename);
  } finally { await rm(temporary, { force: true }); }
  return { purpose, changed: true };
}

function argumentsForImport(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!['--purpose', '--file'].includes(key) || !value || Object.hasOwn(options, key.slice(2))) {
      throw new Error('Usage: npm run setup:google -- --purpose <purpose> --file <downloaded-client.json>');
    }
    options[key.slice(2)] = value;
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => importGoogleDevelopmentClient(argumentsForImport(process.argv.slice(2))))
    .then(({ purpose, changed }) => { console.log(`${purpose} localhost client ${changed ? 'imported' : 'already configured'} in ${DEVELOPMENT_ENV_FILE} (owner-only). Credentials are not printed.`); })
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
