// Web Crypto works in Workers and Node; vault keys never live in D1 or CRM backups.
export class ProviderConnectionError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) { super(message); this.name = 'ProviderConnectionError'; this.status = status; }
}
const encoder = new TextEncoder();
export function base64Url(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decode(value: unknown, maximum: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !value || value.length > maximum || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding');
  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
  if (base64Url(bytes) !== value) throw new Error('Noncanonical encoding');
  return bytes;
}
export function randomProviderSecret(): string { return base64Url(crypto.getRandomValues(new Uint8Array(32))); }
export async function providerDigest(value: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}
export type ProviderKeyring = { active: string; keys: Record<string, string> };
export function providerKeyring(value: string | undefined): ProviderKeyring {
  try {
    if (!value || value.length > 4096) throw new Error();
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).sort().join(',') !== 'active,keys'
      || typeof parsed.active !== 'string' || !parsed.keys || Array.isArray(parsed.keys) || typeof parsed.keys !== 'object') throw new Error();
    const entries = Object.entries(parsed.keys);
    if (entries.length < 1 || entries.length > 8 || !Object.hasOwn(parsed.keys, parsed.active)) throw new Error();
    for (const [id, key] of entries) if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || decode(key, 43).length !== 32) throw new Error();
    return parsed;
  } catch { throw new ProviderConnectionError('Google connections are not configured on this server.', 503); }
}
export type VaultBinding = { purpose: 'credential' | 'authorization'; workspaceId: string; userId: string; id: string };
function additionalData(binding: VaultBinding): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify(['everclose-provider-v1', 'google', binding.purpose, binding.workspaceId, binding.userId, binding.id]));
}
async function key(keyring: ProviderKeyring, id: string) {
  if (!Object.hasOwn(keyring.keys, id)) throw new Error('Missing key');
  return crypto.subtle.importKey('raw', decode(keyring.keys[id], 43), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function sealProviderValue(value: unknown, binding: VaultBinding, keyring: ProviderKeyring): Promise<string> {
  const plaintext = encoder.encode(JSON.stringify(value));
  if (plaintext.byteLength > 24 * 1024) throw new ProviderConnectionError('Provider credentials are invalid.', 502);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: additionalData(binding) }, await key(keyring, keyring.active), plaintext);
  return JSON.stringify({ version: 1, key: keyring.active, iv: base64Url(iv), data: base64Url(new Uint8Array(ciphertext)) });
}
export async function openProviderValue<T>(value: string, binding: VaultBinding, keyring: ProviderKeyring): Promise<T> {
  try {
    if (value.length > 36 * 1024) throw new Error();
    const envelope = JSON.parse(value);
    if (Object.keys(envelope).sort().join(',') !== 'data,iv,key,version' || envelope.version !== 1 || typeof envelope.key !== 'string') throw new Error();
    const iv = decode(envelope.iv, 16);
    if (iv.length !== 12) throw new Error();
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: additionalData(binding) },
      await key(keyring, envelope.key), decode(envelope.data, 34 * 1024));
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decrypted));
  } catch { throw new ProviderConnectionError('Stored authorization is unavailable. Restore the server key or reconnect this account.', 503); }
}
