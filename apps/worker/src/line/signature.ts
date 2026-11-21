/** x-line-signature = base64(HMAC-SHA256(channelSecret, rawBody)). Uses WebCrypto (Workers + Node 20). */
const enc = new TextEncoder();

async function hmacBase64(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyLineSignature(rawBody: string, signature: string | undefined | null, secret: string): Promise<boolean> {
  if (!signature) return false;
  return timingSafeEqual(await hmacBase64(secret, rawBody), signature);
}

/** For tests / local tools. */
export const signLineBody = hmacBase64;
