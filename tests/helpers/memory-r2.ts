export function memoryR2() {
  const objects = new Map<string, { bytes: Uint8Array; uploaded: Date; customMetadata: Record<string, string> }>();
  const uploads = new Map<string, { key: string; parts: Map<number, { bytes: Uint8Array; etag: string }> }>();
  const multipart = (key: string, uploadId: string) => ({
    key, uploadId,
    async uploadPart(partNumber: number, value: Uint8Array) {
      const upload = uploads.get(uploadId);
      if (!upload || upload.key !== key) throw new Error('Multipart upload is unavailable.');
      const bytes = value.slice();
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      const etag = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
      upload.parts.set(partNumber, { bytes, etag });
      return { partNumber, etag };
    },
    async complete(parts: Array<{ partNumber: number; etag: string }>) {
      const upload = uploads.get(uploadId);
      if (!upload || upload.key !== key) throw new Error('Multipart upload is unavailable.');
      let size = 0;
      for (const part of parts) {
        const stored = upload.parts.get(part.partNumber);
        if (!stored || stored.etag !== part.etag) throw new Error('Multipart part is unavailable.');
        size += stored.bytes.byteLength;
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        const stored = upload.parts.get(part.partNumber)!;
        bytes.set(stored.bytes, offset);
        offset += stored.bytes.byteLength;
      }
      objects.set(key, { bytes, uploaded: new Date(), customMetadata: {} });
      uploads.delete(uploadId);
      return { key, size };
    },
    async abort() { uploads.delete(uploadId); },
  });
  return {
    async head(key: string) {
      const object = objects.get(key);
      return object ? { key, size: object.bytes.byteLength } : null;
    },
    async put(key: string, value: Uint8Array | ArrayBuffer | string, options?: { customMetadata?: Record<string, string> }) {
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
      objects.set(key, { bytes: bytes.slice(), uploaded: new Date(), customMetadata: options?.customMetadata || {} });
      return {};
    },
    async get(key: string) {
      const object = objects.get(key);
      if (!object) return null;
      return { key, size: object.bytes.byteLength, uploaded: object.uploaded, customMetadata: object.customMetadata,
        body: new Response(object.bytes).body,
        async arrayBuffer() { return object.bytes.slice().buffer; },
        async text() { return new TextDecoder().decode(object.bytes); },
      };
    },
    async delete(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); },
    async createMultipartUpload(key: string) {
      const uploadId = crypto.randomUUID();
      uploads.set(uploadId, { key, parts: new Map() });
      return multipart(key, uploadId);
    },
    resumeMultipartUpload: multipart,
    async list(options: { prefix?: string; limit?: number; cursor?: string }) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(options.prefix || '') && (!options.cursor || key > options.cursor)).sort();
      const page = keys.slice(0, options.limit || 1000);
      const truncated = keys.length > page.length;
      return { objects: page.map((key) => { const object = objects.get(key)!; return { key, size: object.bytes.byteLength, uploaded: object.uploaded, customMetadata: object.customMetadata }; }), truncated, cursor: truncated ? page.at(-1) : undefined };
    },
  };
}
