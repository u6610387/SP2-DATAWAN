/** VAPID helpers for the owner Web Push opt-in. */

export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64Safe);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/**
 * Was this push subscription created with `currentKey`? After a VAPID key rotation an existing
 * subscription is bound to the old key and the push service rejects every push signed with the
 * new one, so the caller must unsubscribe and let the owner opt in again.
 * `null` (browser doesn't expose the key) is treated as "unknown → re-subscribe".
 */
export function subscriptionUsesKey(applicationServerKey: ArrayBuffer | null, currentKey: string): boolean {
  if (!applicationServerKey) return false;
  const a = new Uint8Array(applicationServerKey);
  const b = urlBase64ToUint8Array(currentKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
