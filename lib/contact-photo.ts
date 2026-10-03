export const MAX_EMBEDDED_CONTACT_PHOTO_CHARACTERS = 180_000;
export const MAX_CONTACT_PHOTO_SOURCE_BYTES = 10 * 1024 * 1024;
export const CONTACT_PHOTO_DIMENSION = 320;

export type EmbeddedContactPhoto = {
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  base64: string;
};

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeBase64Prefix(value: string, maximumBytes = 16): number[] {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const character of value) {
    if (character === '=') break;
    const index = BASE64_ALPHABET.indexOf(character);
    if (index < 0) return [];
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
      if (bytes.length >= maximumBytes) break;
    }
  }
  return bytes;
}

function hasExpectedSignature(mimeType: EmbeddedContactPhoto['mimeType'], base64: string): boolean {
  const bytes = decodeBase64Prefix(base64);
  if (mimeType === 'image/jpeg') {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      .every((byte, index) => bytes[index] === byte);
  }
  return bytes[0] === 0x52
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x46
    && bytes[8] === 0x57
    && bytes[9] === 0x45
    && bytes[10] === 0x42
    && bytes[11] === 0x50;
}

export function parseEmbeddedContactPhoto(value: unknown): EmbeddedContactPhoto | null {
  if (typeof value !== 'string' || value.length > MAX_EMBEDDED_CONTACT_PHOTO_CHARACTERS) return null;
  const match = value.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[2].length % 4 !== 0) return null;
  const mimeType = match[1] as EmbeddedContactPhoto['mimeType'];
  if (!hasExpectedSignature(mimeType, match[2])) return null;
  return { mimeType, base64: match[2] };
}

export function isEmbeddedContactPhoto(value: unknown): value is string {
  return parseEmbeddedContactPhoto(value) !== null;
}
