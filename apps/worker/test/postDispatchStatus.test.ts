/**
 * Pull-on-message after payment: a customer asking "ของถึงยัง" in chat gets the current status,
 * the Lalamove tracking link and a LIFF button — always via the free replyToken, never a push
 * (MAX_PUSH_PER_ORDER=1 is already spent on the price quote; CLAUDE.md §3.4 / D2).
 */
import { describe, expect, it } from 'vitest';
import { findPostback, makeHarness } from './harness';

const TRACK = 'https://share.lalamove.com/abc123';

async function toPaid(h: ReturnType<typeof makeHarness>) {
  await h.customerText('ปูม้า 1 โล');
  await h.customerPostback(findPostback(h.line.lastReply(), 'confirm'));
  await h.customerLocation(13.7, 100.4, 'บ้าน');
  const o = h.repo.orders.at(-1)!;
  await h.ownerText(`${o.code} 900`);
  await h.customerPostback(`a=accept&o=${o.id}`);
  await h.ownerText(`${o.code} ship 100`);
  await h.customerImage('slip-1', new Uint8Array(200).fill(7));
  await h.ownerText(`${o.code} paid! ทดสอบ`);
  expect(h.repo.orders.at(-1)!.status).toBe('PAID');
  return o.code;
}

/** Send a customer text and return the reply JSON + how many pushes it cost. */
async function ask(h: ReturnType<typeof makeHarness>, text: string) {
  const pushesBefore = h.line.pushes.length;
  const pushCountBefore = h.repo.orders.at(-1)!.push_count;
  const repliesBefore = h.line.replies.length;
  await h.customerText(text);
  expect(h.line.replies.length).toBe(repliesBefore + 1); // answered via the Reply API
  return {
    reply: h.line.lastReplyText(),
    pushesUsed: h.line.pushes.length - pushesBefore,
    pushCountDelta: h.repo.orders.at(-1)!.push_count - pushCountBefore,
  };
}

describe('customer status questions after payment use the free Reply API', () => {
  it('PAID: preparing for dispatch + LIFF button, no push', async () => {
    const h = makeHarness();
    await toPaid(h);
    const r = await ask(h, 'ส่งกี่โมงคะ');
    expect(r.reply).toContain('กำลังเตรียมจัดส่ง');
    expect(r.reply).toContain('liff.line.me');
    expect(r.pushesUsed).toBe(0);
    expect(r.pushCountDelta).toBe(0);
  });

  it('DELIVERING (dispatched): status + Lalamove tracking button + LIFF button, no push', async () => {
    const h = makeHarness();
    const code = await toPaid(h);
    await h.ownerText(`${code} track ${TRACK}`);
    expect(h.repo.orders.at(-1)!.status).toBe('DELIVERING');

    const r = await ask(h, 'ของถึงไหนแล้วคะ');
    expect(r.reply).toContain('กำลังจัดส่ง');
    expect(r.reply).toContain(`"uri":"${TRACK}"`); // tappable tracking button
    expect(r.reply).toContain('ติดตามการจัดส่ง');
    expect(r.reply).toContain('liff.line.me');
    expect(r.pushesUsed).toBe(0);
    expect(r.pushCountDelta).toBe(0);
  });

  it('DELIVERED (active order already cleared): completion status + tracking + LIFF, no push, no new order', async () => {
    const h = makeHarness();
    const code = await toPaid(h);
    await h.ownerText(`${code} track ${TRACK}`);
    await h.ownerText(`${code} done`);
    expect(h.repo.orders.at(-1)!.status).toBe('DELIVERED');
    expect(h.repo.users[0]!.active_order_id).toBeNull();
    const ordersBefore = h.repo.orders.length;

    for (const text of ['ของถึงแล้วใช่ไหมคะ', 'ขอบคุณค่ะ']) {
      const r = await ask(h, text);
      expect(r.reply).toContain('จัดส่งสำเร็จแล้ว');
      expect(r.reply).toContain(`"uri":"${TRACK}"`);
      expect(r.reply).toContain('liff.line.me');
      expect(r.pushesUsed).toBe(0);
      expect(r.pushCountDelta).toBe(0);
    }
    expect(h.repo.orders.length).toBe(ordersBefore); // a status question never opens a new order
  });

  it('DELIVERED long ago: falls back to the normal welcome, and a real order still starts a new one', async () => {
    const h = makeHarness();
    const code = await toPaid(h);
    await h.ownerText(`${code} track ${TRACK}`);
    await h.ownerText(`${code} done`);
    expect(h.repo.orders.at(-1)!.status).toBe('DELIVERED');
    const deliveredId = h.repo.orders.at(-1)!.id;
    h.clock.advance((h.deps.cfg.RECENT_ORDER_STATUS_HOURS + 1) * 60);
    const r = await ask(h, 'สวัสดีค่ะ');
    expect(r.reply).not.toContain('จัดส่งสำเร็จแล้ว');
    expect(r.reply).toContain('ยินดีต้อนรับ');

    await h.customerText('ปูม้า 2 โล'); // a real order is still an order, never swallowed by the status reply
    expect(h.repo.orders).toHaveLength(2);
    expect(h.repo.orders.at(-1)!.id).not.toBe(deliveredId);
    expect(h.repo.orders.at(-1)!.status).toBe('AWAITING_CONFIRMATION');
  });
});
