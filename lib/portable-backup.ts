const encoder = new TextEncoder();
const MAGIC = encoder.encode('BONDSENC0001');
const ITERATION_OFFSET = MAGIC.byteLength;
const SALT_OFFSET = ITERATION_OFFSET + 4;
const IV_OFFSET = SALT_OFFSET + 16;
const HEADER_LENGTH = IV_OFFSET + 12;
const AUTHENTICATION_TAG_BYTES = 16;
const MINIMUM_ITERATIONS = 100_000;
const MAXIMUM_ITERATIONS = 2_000_000;

export const PORTABLE_BACKUP_PBKDF2_ITERATIONS = 600_000;
export const PORTABLE_BACKUP_MINIMUM_PASSPHRASE_LENGTH = 12;
export const PORTABLE_BACKUP_EXTENSION = '.bonds';
export const PORTABLE_BACKUP_MIME_TYPE = 'application/vnd.bonds.backup';
export const PORTABLE_BACKUP_OVERHEAD_BYTES = HEADER_LENGTH + AUTHENTICATION_TAG_BYTES;

type EncryptionOptions = {
  iterations?: number;
};

export class PortableBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortableBackupError';
  }
}

function toBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array<ArrayBuffer> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value.buffer instanceof ArrayBuffer) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  const source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
}

function validatePassphrase(passphrase: string): Uint8Array<ArrayBuffer> {
  const bytes = toBytes(encoder.encode(passphrase));
  if (passphrase.trim().length < PORTABLE_BACKUP_MINIMUM_PASSPHRASE_LENGTH) {
    throw new PortableBackupError(
      `Backup passphrases must be at least ${PORTABLE_BACKUP_MINIMUM_PASSPHRASE_LENGTH} characters.`
    );
  }
  if (bytes.byteLength > 1024) {
    throw new PortableBackupError('Backup passphrases must be no more than 1,024 bytes.');
  }
  return bytes;
}

function validateIterations(iterations: number): number {
  if (!Number.isInteger(iterations) || iterations < MINIMUM_ITERATIONS || iterations > MAXIMUM_ITERATIONS) {
    throw new PortableBackupError('Encrypted backup work factor is not supported.');
  }
  return iterations;
}

function hasMagic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < MAGIC.byteLength) return false;
  for (let index = 0; index < MAGIC.byteLength; index++) {
    if (bytes[index] !== MAGIC[index]) return false;
  }
  return true;
}

async function deriveEncryptionKey(
  passphrase: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number
): Promise<CryptoKey> {
  const baseKey = await globalThis.crypto.subtle.importKey(
    'raw',
    passphrase,
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return globalThis.crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function parseHeader(bytes: Uint8Array<ArrayBuffer>) {
  if (bytes.byteLength < PORTABLE_BACKUP_OVERHEAD_BYTES || !hasMagic(bytes)) {
    throw new PortableBackupError('This is not a supported encrypted Everclose CRM backup.');
  }
  const iterations = validateIterations(new DataView(bytes.buffer).getUint32(ITERATION_OFFSET, false));
  return {
    iterations,
    header: bytes.subarray(0, HEADER_LENGTH),
    salt: bytes.subarray(SALT_OFFSET, IV_OFFSET),
    iv: bytes.subarray(IV_OFFSET, HEADER_LENGTH),
    ciphertext: bytes.subarray(HEADER_LENGTH),
  };
}

export function isPortableBackup(value: ArrayBuffer | ArrayBufferView): boolean {
  return hasMagic(toBytes(value));
}

export function getPortableBackupFilename(filename: string): string {
  const basename = filename.split(/[\\/]/).pop() || 'bonds-backup';
  const withoutExtension = basename.replace(/\.db$/i, '');
  const safe = withoutExtension
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 100) || 'bonds-backup';
  return `${safe}${PORTABLE_BACKUP_EXTENSION}`;
}

export async function encryptPortableBackup(
  plaintext: ArrayBuffer | ArrayBufferView,
  passphrase: string,
  options: EncryptionOptions = {}
): Promise<Uint8Array<ArrayBuffer>> {
  const data = toBytes(plaintext);
  if (data.byteLength === 0) throw new PortableBackupError('The backup file is empty.');
  const passphraseBytes = validatePassphrase(passphrase);
  const iterations = validateIterations(options.iterations ?? PORTABLE_BACKUP_PBKDF2_ITERATIONS);
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const header = new Uint8Array(HEADER_LENGTH);
  header.set(MAGIC, 0);
  new DataView(header.buffer).setUint32(ITERATION_OFFSET, iterations, false);
  header.set(salt, SALT_OFFSET);
  header.set(iv, IV_OFFSET);

  const key = await deriveEncryptionKey(passphraseBytes, salt, iterations);
  const encrypted = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: header, tagLength: 128 },
    key,
    data
  );
  const ciphertext = toBytes(encrypted);
  const result = new Uint8Array(header.byteLength + ciphertext.byteLength);
  result.set(header, 0);
  result.set(ciphertext, header.byteLength);
  return result;
}

export async function decryptPortableBackup(
  encryptedBackup: ArrayBuffer | ArrayBufferView,
  passphrase: string
): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = toBytes(encryptedBackup);
  const { iterations, header, salt, iv, ciphertext } = parseHeader(bytes);
  const passphraseBytes = validatePassphrase(passphrase);

  try {
    const key = await deriveEncryptionKey(passphraseBytes, salt, iterations);
    const decrypted = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: header, tagLength: 128 },
      key,
      ciphertext
    );
    return toBytes(decrypted);
  } catch {
    throw new PortableBackupError('The passphrase is incorrect or the encrypted backup is damaged.');
  }
}
