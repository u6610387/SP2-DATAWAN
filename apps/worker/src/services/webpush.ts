/**
 * Owner push notifications — VAPID Web Push (RFC 8291 "aes128gcm" encryption + RFC 8292 VAPID
 * JWT), implemented with only Web Crypto + fetch so it runs natively on Cloudflare Workers.
 * `web-push`'s Node implementation shells out to `https.request`, a poor fit for Workers —
 * this file is the zero-dependency, Workers-native replacement CLAUDE.md §3.4 calls for
 * ("owner notifications use PWA Web Push, never LINE push").
 */
import type { Config } from '../env';
import type { OwnerAlert, OwnerNotifier } from './notifier';
import type { Repo } from './repo';

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

// ---------------- base64url ----------------

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(str.length / 4) * 4, '=');
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * `@types/node` widens the global `Uint8Array`'s default buffer generic to `ArrayBufferLike`
 * (covers `SharedArrayBuffer`), which the DOM `BufferSource`/WebCrypto types reject even though
 * every array here is always backed by a plain, freshly-allocated `ArrayBuffer` at runtime.
 */
function bs(u: Uint8Array): BufferSource {
  return u as unknown as BufferSource;
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

// ---------------- VAPID JWT (RFC 8292) ----------------

async function importVapidPrivateKey(privateKeyB64url: string, publicKeyB64url: string): Promise<CryptoKey> {
  const pub = b64urlDecode(publicKeyB64url); // 0x04 || X(32) || Y(32)
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    d: b64urlEncode(b64urlDecode(privateKeyB64url)),
    x: b64urlEncode(pub.slice(1, 33)),
    y: b64urlEncode(pub.slice(33, 65)),
    ext: true,
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/**
 * Config audit helper: does VAPID_PRIVATE_KEY actually belong to VAPID_PUBLIC_KEY?
 * Signs with the private key and verifies with the raw public key — a mismatched pair fails.
 */
export async function vapidKeyPairMatches(privateKeyB64url: string, publicKeyB64url: string): Promise<boolean> {
  try {
    const pubRaw = b64urlDecode(publicKeyB64url);
    if (pubRaw.length !== 65 || pubRaw[0] !== 0x04) return false;
    const priv = await importVapidPrivateKey(privateKeyB64url, publicKeyB64url);
    const pub = await crypto.subtle.importKey('raw', bs(pubRaw), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const msg = bs(utf8('datawan-config-audit'));
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, msg);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, msg);
  } catch {
    return false;
  }
}

/** `Authorization: vapid t=<jwt>, k=<publicKey>` per RFC 8292. */
export async function vapidAuthHeader(endpoint: string, cfg: Pick<Config, 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY' | 'VAPID_SUBJECT'>): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: cfg.VAPID_SUBJECT };
  const signingInput = `${b64urlEncode(utf8(JSON.stringify(header)))}.${b64urlEncode(utf8(JSON.stringify(payload)))}`;
  const key = await importVapidPrivateKey(cfg.VAPID_PRIVATE_KEY, cfg.VAPID_PUBLIC_KEY);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, bs(utf8(signingInput)));
  const jwt = `${signingInput}.${b64urlEncode(new Uint8Array(sig))}`;
  return `vapid t=${jwt}, k=${cfg.VAPID_PUBLIC_KEY}`;
}

// ---------------- HKDF-SHA256 ----------------

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', bs(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: bs(salt), info: bs(info) }, key, length * 8);
  return new Uint8Array(bits);
}

// ---------------- payload encryption (RFC 8291 aes128gcm) ----------------

/** Encrypts `plaintext` for one subscription. Returns the full aes128gcm body to POST. */
export async function encryptPayload(sub: PushSubscriptionInput, plaintext: Uint8Array): Promise<Uint8Array> {
  const uaPublic = b64urlDecode(sub.keys.p256dh); // recipient's raw EC public key (65 bytes)
  const authSecret = b64urlDecode(sub.keys.auth); // 16 bytes

  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));

  const recipientKey = await crypto.subtle.importKey('raw', bs(uaPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: recipientKey }, ephemeral.privateKey, 256));

  const keyInfo = concat(utf8('WebPush: info\0'), uaPublic, asPublicRaw);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', bs(cek), { name: 'AES-GCM' }, false, ['encrypt']);
  // Single record: plaintext + the 0x02 "last record" delimiter (RFC 8188 §2).
  const padded = concat(plaintext, new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bs(nonce) }, aesKey, bs(padded)));

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  const header = concat(salt, recordSize, new Uint8Array([asPublicRaw.length]), asPublicRaw);
  return concat(header, ciphertext);
}

export async function sendWebPush(
  sub: PushSubscriptionInput,
  payload: string,
  cfg: Pick<Config, 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY' | 'VAPID_SUBJECT'>,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const body = await encryptPayload(sub, utf8(payload));
  const auth = await vapidAuthHeader(sub.endpoint, cfg);
  return fetchImpl(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      TTL: '86400',
      Authorization: auth,
    },
    body: body as BodyInit,
  });
}

// ---------------- OwnerNotifier ----------------

function toPushPayload(alert: OwnerAlert): { title: string; body: string } {
  switch (alert.kind) {
    case 'NEW_ORDER':
      return { title: `ออเดอร์ใหม่ ${alert.code}`, body: alert.summary };
    case 'COUNTER_OFFER':
      return { title: `ลูกค้าต่อราคา ${alert.code}`, body: `เสนอ ${(alert.amountSatang / 100).toFixed(0)} บาท` };
    case 'ACCEPTED':
      return { title: `${alert.code} ลูกค้ารับราคาแล้ว`, body: 'พร้อมคิดค่าส่งได้เลย' };
    case 'SLIP_UPLOADED':
      return { title: `สลิปเข้า ${alert.code}`, body: `ผลตรวจ: ${alert.result}` };
    case 'OWNER_TIMEOUT':
      return { title: `${alert.code} รอมานาน`, body: `ยังไม่ได้ตั้งราคามา ${alert.minutes} นาที` };
    case 'PAYMENT_EXPIRED':
      return { title: `${alert.code} หมดเวลาชำระเงิน`, body: 'ลูกค้ายังไม่โอน' };
    case 'QUOTA_WARNING':
      return { title: 'โควต้า LINE push', body: `ใช้ไป ${alert.used}/${alert.limit} (${alert.mode})` };
    case 'NEEDS_REVIEW':
      return { title: `${alert.code} ต้องตรวจสอบ`, body: alert.reason };
    case 'B2B_APPLICATION':
      return { title: 'มีร้านค้าขอยืนยันตัวตน B2B', body: 'เปิดแท็บ ลูกค้า เพื่อตรวจสอบ' };
    case 'B2B_REREVIEW':
      return { title: 'ร้านค้า B2B แก้ไขข้อมูล รอตรวจ', body: 'เปิดแท็บ ลูกค้า เพื่อตรวจสอบ' };
  }
}

export function createWebPushNotifier(cfg: Pick<Config, 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY' | 'VAPID_SUBJECT'>, repo: Repo, fetchImpl: typeof fetch = fetch): OwnerNotifier {
  return {
    async notify(alert) {
      console.log('[owner-alert]', JSON.stringify(alert));
      if (!cfg.VAPID_PUBLIC_KEY || !cfg.VAPID_PRIVATE_KEY) return; // not configured — console log only
      const subs = await repo.listPushSubscriptions();
      if (!subs.length) return;
      const body = JSON.stringify(toPushPayload(alert));
      await Promise.all(
        subs.map(async (sub) => {
          try {
            const res = await sendWebPush({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body, cfg, fetchImpl);
            if (res.status === 404 || res.status === 410) await repo.deletePushSubscription(sub.endpoint);
          } catch (err) {
            console.warn('[webpush] send failed', err);
          }
        }),
      );
    },
  };
}
