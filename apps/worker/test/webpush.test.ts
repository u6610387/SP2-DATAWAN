/**
 * VAPID JWT + aes128gcm encryption round-trip, verified against independent Web Crypto
 * calls that play the role of the signature-checking push service / decrypting browser —
 * proves the hand-rolled implementation in services/webpush.ts is actually correct, not just
 * "runs without throwing".
 */
import { describe, expect, it } from 'vitest';
import { encryptPayload, vapidAuthHeader } from '../src/services/webpush';

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBytes(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(str.length / 4) * 4, '=');
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource }, key, length * 8);
  return new Uint8Array(bits);
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

describe('webpush', () => {
  it('vapidAuthHeader produces a JWT that verifies against the VAPID public key', async () => {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    const jwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey;
    const cfg = { VAPID_PUBLIC_KEY: b64url(pubRaw), VAPID_PRIVATE_KEY: jwk.d!, VAPID_SUBJECT: 'mailto:test@example.com' };

    const header = await vapidAuthHeader('https://push.example.com/abc/def', cfg);
    expect(header.startsWith('vapid t=')).toBe(true);
    const jwt = header.slice('vapid t='.length).split(', k=')[0]!;
    const [h, p, s] = jwt.split('.') as [string, string, string];
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p))) as { aud: string; sub: string; exp: number };
    expect(payload.aud).toBe('https://push.example.com');
    expect(payload.sub).toBe('mailto:test@example.com');
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const verifyKey = await crypto.subtle.importKey('raw', pubRaw as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifyKey,
      b64urlToBytes(s) as BufferSource,
      new TextEncoder().encode(`${h}.${p}`) as BufferSource,
    );
    expect(ok).toBe(true);
  });

  it('encryptPayload round-trips: a simulated browser recovers the original plaintext', async () => {
    const recipient = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const uaPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', recipient.publicKey));
    const authSecret = crypto.getRandomValues(new Uint8Array(16));
    const sub = { endpoint: 'https://push.example.com/sub1', keys: { p256dh: b64url(uaPublicRaw), auth: b64url(authSecret) } };

    const plaintext = 'hello from Da Tawan Seafood';
    const body = await encryptPayload(sub, new TextEncoder().encode(plaintext));

    // Decrypt as the browser would, independently of encryptPayload's own code path.
    const salt = body.slice(0, 16);
    const idlen = body[20]!;
    const asPublicRaw = body.slice(21, 21 + idlen);
    const ciphertext = body.slice(21 + idlen);

    const asPublicKey = await crypto.subtle.importKey('raw', asPublicRaw as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asPublicKey }, recipient.privateKey, 256));
    const keyInfo = concat(new TextEncoder().encode('WebPush: info\0'), uaPublicRaw, asPublicRaw);
    const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
    const cek = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
    const nonce = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);
    const aesKey = await crypto.subtle.importKey('raw', cek as BufferSource, { name: 'AES-GCM' }, false, ['decrypt']);
    const decrypted = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, aesKey, ciphertext as BufferSource));

    expect(new TextDecoder().decode(decrypted.slice(0, -1))).toBe(plaintext);
    expect(decrypted.at(-1)).toBe(2); // RFC 8188 last-record delimiter
  });

  it('two encryptions of the same plaintext differ (fresh salt + ephemeral key each time)', async () => {
    const recipient = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const uaPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', recipient.publicKey));
    const authSecret = crypto.getRandomValues(new Uint8Array(16));
    const sub = { endpoint: 'https://push.example.com/sub2', keys: { p256dh: b64url(uaPublicRaw), auth: b64url(authSecret) } };
    const a = await encryptPayload(sub, new TextEncoder().encode('same message'));
    const b = await encryptPayload(sub, new TextEncoder().encode('same message'));
    expect(b64url(a)).not.toBe(b64url(b));
  });
});
