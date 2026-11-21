/** Slip / bill image storage (Supabase Storage, private buckets). */
export type Bucket = 'slips' | 'supplier-bills';
export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

/** Splits a stored path like 'slips/<orderId>/<uuid>.jpg' (as returned by upload()) back into bucket + key. */
export function splitPath(path: string): { bucket: Bucket; key: string } {
  const [bucket, ...rest] = path.split('/');
  return { bucket: bucket as Bucket, key: rest.join('/') };
}

export interface ImageStorage {
  /** Returns the storage path, e.g. 'slips/<orderId>/<uuid>.jpg'. */
  upload(bucket: Bucket, key: string, bytes: Uint8Array, contentType: string): Promise<string>;
  /** Fetch bytes already uploaded (e.g. by a LIFF client PUT to a signed URL) to run AI on them. */
  download(bucket: Bucket, key: string): Promise<{ bytes: Uint8Array; contentType: ImageMime }>;
  /** A short-lived URL the LIFF client can PUT the file to directly (never through the Worker). */
  createSignedUploadUrl(bucket: Bucket, key: string): Promise<{ uploadUrl: string; path: string }>;
  /** A short-lived GET URL for the owner dashboard to preview a private slip/bill image. */
  getSignedUrl(bucket: Bucket, key: string, expiresInSeconds: number): Promise<string>;
  /** Delete objects older than `days`; returns count deleted. */
  deleteOlderThan(bucket: Bucket, days: number, now: Date): Promise<number>;
}

export function createSupabaseStorage(supabaseUrl: string, serviceRoleKey: string, fetchImpl: typeof fetch = fetch): ImageStorage {
  const headers = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };
  return {
    async upload(bucket, key, bytes, contentType) {
      const res = await fetchImpl(`${supabaseUrl}/storage/v1/object/${bucket}/${key}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': contentType, 'x-upsert': 'false' },
        body: new Blob([bytes as BlobPart], { type: contentType }),
      });
      if (!res.ok) throw new Error(`storage upload failed: ${res.status} ${await res.text()}`);
      return `${bucket}/${key}`;
    },
    async download(bucket, key) {
      const res = await fetchImpl(`${supabaseUrl}/storage/v1/object/${bucket}/${key}`, { headers });
      if (!res.ok) throw new Error(`storage download failed: ${res.status} ${await res.text()}`);
      const contentType = (res.headers.get('content-type') ?? 'image/jpeg') as ImageMime;
      return { bytes: new Uint8Array(await res.arrayBuffer()), contentType };
    },
    async createSignedUploadUrl(bucket, key) {
      const res = await fetchImpl(`${supabaseUrl}/storage/v1/object/upload/sign/${bucket}/${key}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`storage signed-upload failed: ${res.status} ${await res.text()}`);
      const { url } = (await res.json()) as { url: string };
      return { uploadUrl: `${supabaseUrl}/storage/v1${url}`, path: `${bucket}/${key}` };
    },
    async getSignedUrl(bucket, key, expiresInSeconds) {
      const res = await fetchImpl(`${supabaseUrl}/storage/v1/object/sign/${bucket}/${key}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: expiresInSeconds }),
      });
      if (!res.ok) throw new Error(`storage sign failed: ${res.status} ${await res.text()}`);
      const { signedURL } = (await res.json()) as { signedURL: string };
      return `${supabaseUrl}/storage/v1${signedURL}`;
    },
    async deleteOlderThan(bucket, days, now) {
      const cutoff = now.getTime() - days * 86_400_000;
      let deleted = 0;
      // Objects are stored as <orderId>/<file>; list top-level folders, then files.
      const list = async (prefix: string) => {
        const res = await fetchImpl(`${supabaseUrl}/storage/v1/object/list/${bucket}`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefix, limit: 1000, offset: 0, sortBy: { column: 'created_at', order: 'asc' } }),
        });
        if (!res.ok) throw new Error(`storage list failed: ${res.status}`);
        return (await res.json()) as { name: string; id: string | null; created_at: string | null }[];
      };
      for (const folder of await list('')) {
        const prefix = folder.id === null ? `${folder.name}/` : '';
        const files = folder.id === null ? await list(prefix) : [folder];
        const old = files.filter((f) => f.id !== null && f.created_at && Date.parse(f.created_at) < cutoff).map((f) => `${prefix}${f.name}`);
        if (!old.length) continue;
        const res = await fetchImpl(`${supabaseUrl}/storage/v1/object/${bucket}`, {
          method: 'DELETE',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefixes: old }),
        });
        if (res.ok) deleted += old.length;
      }
      return deleted;
    },
  };
}

export class MemoryStorage implements ImageStorage {
  objects = new Map<string, { bytes: Uint8Array; contentType: ImageMime; at: number }>();
  async upload(bucket: string, key: string, bytes: Uint8Array, contentType: string) {
    const path = `${bucket}/${key}`;
    this.objects.set(path, { bytes, contentType: contentType as ImageMime, at: Date.now() });
    return path;
  }
  async download(bucket: string, key: string) {
    const obj = this.objects.get(`${bucket}/${key}`);
    if (!obj) throw new Error(`no object ${bucket}/${key}`);
    return { bytes: obj.bytes, contentType: obj.contentType };
  }
  async createSignedUploadUrl(bucket: string, key: string) {
    return { uploadUrl: `memory://upload/${bucket}/${key}`, path: `${bucket}/${key}` };
  }
  async getSignedUrl(bucket: string, key: string) {
    return `memory://signed/${bucket}/${key}`;
  }
  async deleteOlderThan(_bucket: string, days: number, now: Date) {
    let n = 0;
    for (const [k, v] of this.objects) if (v.at < now.getTime() - days * 86_400_000) { this.objects.delete(k); n++; }
    return n;
  }
}
