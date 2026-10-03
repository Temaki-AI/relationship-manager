import { parseEmbeddedContactPhoto } from './contact-photo.ts';

export function embeddedContactPhotoResponse(value: unknown): Response | null {
  const photo = parseEmbeddedContactPhoto(value);
  if (!photo) return null;
  const bytes = Uint8Array.from(atob(photo.base64), (character) => character.charCodeAt(0));
  return new Response(bytes, {
    headers: {
      'Content-Type': photo.mimeType,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
