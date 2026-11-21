/** Slip / bill image storage (Supabase Storage, private buckets). */
export interface ImageStorage {
  /** Returns the storage path, e.g. 'slips/<orderId>/<uuid>.jpg'. */
  upload(bucket: 'slips' | 'supplier-bills', key: string, bytes: Uint8Array, contentType: string): Promise<string>;
  /** Delete objects older than `days`; returns count deleted. */
  deleteOlderThan(bucket: 'slips' | 'supplier-bills', days: number, now: Date): Promise<number>;
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
  objects = new Map<string, { bytes: Uint8Array; at: number }>();
  async upload(bucket: string, key: string, bytes: Uint8Array) {
    const path = `${bucket}/${key}`;
    this.objects.set(path, { bytes, at: Date.now() });
    return path;
  }
  async deleteOlderThan(_bucket: string, days: number, now: Date) {
    let n = 0;
    for (const [k, v] of this.objects) if (v.at < now.getTime() - days * 86_400_000) { this.objects.delete(k); n++; }
    return n;
  }
}
