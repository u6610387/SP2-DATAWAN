/**
 * Thin LINE Messaging API client over fetch (Workers-friendly). @line/bot-sdk is used for types.
 *
 * IMPORTANT: `unsafePush` must only be called from line/quota.ts (sendPushGuarded).
 */
import type { messagingApi } from '@line/bot-sdk';

export type LineMessage = messagingApi.Message;

export interface LineApi {
  reply(replyToken: string, messages: LineMessage[]): Promise<void>;
  /** Raw push — DO NOT CALL outside line/quota.ts. */
  unsafePush(to: string, messages: LineMessage[]): Promise<void>;
  getContent(messageId: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  getQuota(): Promise<{ type: 'none' | 'limited'; value?: number }>;
  getConsumption(): Promise<{ totalUsage: number }>;
}

export class LineApiError extends Error {
  constructor(public readonly status: number, public readonly body: string, op: string) {
    super(`LINE ${op} failed: ${status} ${body.slice(0, 200)}`);
  }
}

export function createLineApi(accessToken: string, fetchImpl: typeof fetch = fetch): LineApi {
  const auth = { Authorization: `Bearer ${accessToken}` };
  async function call(op: string, url: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetchImpl(url, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
    if (!res.ok) throw new LineApiError(res.status, await res.text(), op);
    return res;
  }
  const json = { 'Content-Type': 'application/json' };
  return {
    async reply(replyToken, messages) {
      await call('reply', 'https://api.line.me/v2/bot/message/reply', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ replyToken, messages: messages.slice(0, 5) }),
      });
    },
    async unsafePush(to, messages) {
      await call('push', 'https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: { ...json, 'X-Line-Retry-Key': crypto.randomUUID() },
        body: JSON.stringify({ to, messages: messages.slice(0, 5) }),
      });
    },
    async getContent(messageId) {
      const res = await call('content', `https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`);
      return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? 'image/jpeg' };
    },
    async getQuota() {
      return (await call('quota', 'https://api.line.me/v2/bot/message/quota')).json();
    },
    async getConsumption() {
      return (await call('consumption', 'https://api.line.me/v2/bot/message/quota/consumption')).json();
    },
  };
}
