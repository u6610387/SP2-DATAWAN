/** Test harness: real handlers + in-memory repo + fake LINE API, signed webhook events. */
import { createAi } from '@datawan/ai';
import type { AuthVerifier } from '../src/auth/types';
import type { Deps } from '../src/deps';
import { loadConfig } from '../src/env';
import type { LineApi, LineMessage } from '../src/line/api';
import { signLineBody } from '../src/line/signature';
import { RecordingNotifier } from '../src/services/notifier';
import { RecordingBroadcaster } from '../src/services/realtime';
import { MemoryRepo } from '../src/services/repo.memory';
import { MemoryStorage } from '../src/services/storage';
import { handleWebhook } from '../src/routes/webhook';

/** Deterministic auth for tests: fixed token→id maps instead of calling Supabase/LINE. */
export class FakeAuth implements AuthVerifier {
  owners = new Map<string, string>();
  liffUsers = new Map<string, string>();
  async verifyOwner(token: string | null) {
    if (!token) return null;
    const id = this.owners.get(token);
    return id ? { id } : null;
  }
  async verifyLiffUser(idToken: string | null, devUserHeader: string | null) {
    if (devUserHeader) return { lineUserId: devUserHeader };
    if (!idToken) return null;
    const lineUserId = this.liffUsers.get(idToken);
    return lineUserId ? { lineUserId } : null;
  }
}

export const OWNER_LINE = 'U00000000000000000000000000000a11';
/** Second owner account (LINE_OWNER_USER_ID is a comma-separated list). */
export const OWNER_LINE_2 = 'U00000000000000000000000000000a22';
export const CUSTOMER_LINE = 'Ucustomer00000000000000000000000000';
export const OWNER_AUTH = '11111111-1111-4111-8111-111111111111';
export const SECRET = 'test-channel-secret';
export const OWNER_TOKEN = 'test-owner-token';
export const LIFF_TOKEN = 'test-liff-token';

export class FakeLine implements LineApi {
  replies: { token: string; messages: LineMessage[] }[] = [];
  pushes: { to: string; messages: LineMessage[] }[] = [];
  content = new Map<string, Uint8Array>();
  consumption = 0;
  async reply(token: string, messages: LineMessage[]) { this.replies.push({ token, messages }); }
  async unsafePush(to: string, messages: LineMessage[]) { this.pushes.push({ to, messages }); }
  async getContent(id: string) {
    const bytes = this.content.get(id);
    if (!bytes) throw new Error(`no content ${id}`);
    return { bytes, contentType: 'image/jpeg' };
  }
  async getQuota() { return { type: 'limited' as const, value: 300 }; }
  async getConsumption() { return { totalUsage: this.consumption }; }
  lastReply(): LineMessage[] { return this.replies.at(-1)?.messages ?? []; }
  lastReplyText(): string { return JSON.stringify(this.lastReply()); }
}

export function makeHarness(startIso = '2027-01-14T02:20:00Z') {
  let now = new Date(startIso);
  const clock = { now: () => now, advance: (minutes: number) => { now = new Date(now.getTime() + minutes * 60_000); } };
  const cfg = loadConfig({
    LINE_CHANNEL_SECRET: SECRET,
    LINE_CHANNEL_ACCESS_TOKEN: 'token',
    LINE_OWNER_USER_ID: `${OWNER_LINE}, ${OWNER_LINE_2}`,
    LIFF_ID: '2000000000-abcdEFGH',
    OWNER_AUTH_USER_ID: OWNER_AUTH,
    PROMPTPAY_ID: '0812345678',
    PROMPTPAY_RECEIVER_NAME: 'ดา ทะวัน',
    USE_MOCK_AI: 'true',
  });
  const repo = new MemoryRepo(clock.now);
  repo.seedProducts([
    { id: 'p-kung', name_th: 'กุ้งแม่น้ำ', aliases: ['กุ้งก้ามกราม'], unit: 'kg', prep_types: ['live', 'chilled'] },
    { id: 'p-hoi', name_th: 'หอยแครง', aliases: ['แครง'], unit: 'kg', prep_types: ['live'] },
    { id: 'p-pu', name_th: 'ปูม้า', aliases: ['ปู'], unit: 'kg', prep_types: ['live', 'chilled', 'cooked'] },
  ]);
  const line = new FakeLine();
  const notifier = new RecordingNotifier();
  const realtime = new RecordingBroadcaster();
  const auth = new FakeAuth();
  auth.owners.set(OWNER_TOKEN, OWNER_AUTH);
  auth.liffUsers.set(LIFF_TOKEN, CUSTOMER_LINE);
  const deps: Deps = {
    cfg, repo, line, notifier, realtime, auth,
    ai: createAi(cfg, {}, clock.now),
    storage: new MemoryStorage(),
    now: clock.now,
  };
  let seq = 0;
  async function send(userId: string, event: Record<string, unknown>, opts: { id?: string; badSig?: boolean } = {}) {
    const ev = {
      mode: 'active', timestamp: now.getTime(), webhookEventId: opts.id ?? `evt-${++seq}`,
      deliveryContext: { isRedelivery: false }, source: { type: 'user', userId },
      replyToken: `rt-${seq}`, ...event,
    };
    const body = JSON.stringify({ destination: 'Ubot', events: [ev] });
    const sig = opts.badSig ? 'nope' : await signLineBody(SECRET, body);
    return handleWebhook(deps, body, sig);
  }
  const customerText = (text: string) => send(CUSTOMER_LINE, { type: 'message', message: { id: `m${seq + 1}`, type: 'text', quoteToken: 'q', text } });
  const ownerText = (text: string) => send(OWNER_LINE, { type: 'message', message: { id: `m${seq + 1}`, type: 'text', quoteToken: 'q', text } });
  const customerPostback = (data: string) => send(CUSTOMER_LINE, { type: 'postback', postback: { data } });
  const customerLocation = (lat: number, lng: number, address: string) =>
    send(CUSTOMER_LINE, { type: 'message', message: { id: `m${seq + 1}`, type: 'location', latitude: lat, longitude: lng, address } });
  const customerImage = (messageId: string, bytes: Uint8Array) => {
    line.content.set(messageId, bytes);
    return send(CUSTOMER_LINE, { type: 'message', message: { id: messageId, type: 'image', contentProvider: { type: 'line' }, quoteToken: 'q' } });
  };
  /** Cost of goods so margins are known: กุ้ง ฿600/kg, หอย ฿150/kg. */
  async function seedCosts() {
    await repo.insertPriceHistory([
      { product_id: 'p-kung', kind: 'cost', unit_price_satang: 60000, source: 'supplier_bill', user_id: null, order_id: null },
      { product_id: 'p-hoi', kind: 'cost', unit_price_satang: 15000, source: 'supplier_bill', user_id: null, order_id: null },
    ]);
  }
  return { deps, repo, line, notifier, realtime, auth, clock, send, customerText, ownerText, customerPostback, customerLocation, customerImage, seedCosts };
}

/** Extract the postback `data` of the first button whose data starts with `a=<action>`. */
export function findPostback(messages: LineMessage[], action: string): string {
  const m = JSON.stringify(messages).match(new RegExp(`"data":"(a=${action}[^"]*)"`));
  if (!m) throw new Error(`no postback a=${action} in ${JSON.stringify(messages).slice(0, 400)}`);
  return m[1]!.replace(/\\u0026/g, '&');
}
