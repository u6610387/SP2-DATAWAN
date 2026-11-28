/**
 * LINE push slots per order (CLAUDE.md §3.4, D2): exactly PRICE_READY → TOTAL_READY → TRACKING_LINK,
 * at most one push each, all P1 and sent even while LIFF is open (so they land in chat history).
 * Counter / hold / owner notes never push (LIFF realtime + free chat reply).
 */
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { findPostback, LIFF_TOKEN, makeHarness, OWNER_LINE } from './harness';

/* eslint-disable @typescript-eslint/no-explicit-any */
const sentWhys = (h: ReturnType<typeof makeHarness>) =>
  h.repo.events.filter((e) => e.event === 'PUSH_SENT').map((e) => (e.payload as { why: string }).why);
const deferred = (h: ReturnType<typeof makeHarness>) =>
  h.repo.events.filter((e) => e.event === 'PUSH_DEFERRED').map((e) => e.payload as { why: string; reason: string });

async function toPriceAwaiting(h: ReturnType<typeof makeHarness>) {
  await h.customerText('ปูม้า 1 โล');
  await h.customerPostback(findPostback(h.line.lastReply(), 'confirm'));
  await h.customerLocation(13.7, 100.4, 'บ้าน');
  return h.repo.orders.at(-1)!;
}

describe('push slots: price quote, total, tracking — once each', () => {
  it('re-quote and fee correction never push the same step twice', async () => {
    const h = makeHarness();
    const o = await toPriceAwaiting(h);
    await h.ownerText(`${o.code} 900`);
    await h.ownerText(`${o.code} 950`); // PRICE_QUOTED → PRICE_QUOTED re-quote
    expect(sentWhys(h)).toEqual(['PRICE_READY']);
    expect(deferred(h).at(-1)).toMatchObject({ why: 'PRICE_READY', reason: 'ALREADY_SENT' });

    await h.customerPostback(`a=accept&o=${o.id}`);
    await h.ownerText(`${o.code} ship 100`);
    await h.ownerText(`${o.code} ship 120`); // fee correction while AWAITING_PAYMENT
    expect(sentWhys(h)).toEqual(['PRICE_READY', 'TOTAL_READY']);
    expect(deferred(h).at(-1)).toMatchObject({ why: 'TOTAL_READY', reason: 'ALREADY_SENT' });
    expect(h.line.pushes).toHaveLength(2);
    // The customer still sees the corrected total by pulling (free reply).
    await h.customerText('ยอดเท่าไหร่คะ');
    expect(h.line.lastReplyText()).toContain('฿1,070');
  });

  it('counter and hold use no push; the customer sees them in LIFF and in the next chat reply', async () => {
    const h = makeHarness();
    const o = await toPriceAwaiting(h);
    await h.ownerText(`${o.code} 900`);
    await h.customerText('800 ได้ไหมคะ');
    await h.ownerText(`${o.code} 850`); // owner counter
    expect(h.repo.orders.at(-1)!.status).toBe('PRICE_QUOTED');
    expect(h.line.lastReplyText()).toContain('ไม่ใช้ push');
    await h.customerText('820 ได้ไหมคะ');
    await h.ownerText(`${o.code} hold`);
    expect(h.line.lastReplyText()).toContain('ไม่ใช้ push');
    expect(h.line.pushes).toHaveLength(1); // only the first price quote
    expect(h.repo.events.some((e) => (e.event === 'PUSH_SENT' || e.event === 'PUSH_DEFERRED') && ['OWNER_COUNTER', 'OWNER_HOLD'].includes((e.payload as any).why))).toBe(false);

    const view = (await (await createApp(h.deps).request(`/api/liff/orders/${o.id}`, { headers: { Authorization: `Bearer ${LIFF_TOKEN}` } })).json()) as any;
    expect(view).toMatchObject({ status: 'PRICE_QUOTED', productPriceSatang: 85000 });
  });

  it('owner notes: no push, shown in LIFF, and once at the top of the next chat reply', async () => {
    const h = makeHarness();
    const o = await toPriceAwaiting(h);
    await h.ownerText(`${o.code} note ปูหมด มีกุ้งแม่น้ำ 900`);
    await h.send(OWNER_LINE, { type: 'postback', postback: { data: findPostback(h.line.lastReply(), 'note_send') } });
    expect(h.line.pushes).toHaveLength(0);
    const note = (h.repo.events.find((e) => e.event === 'NOTE_APPROVED')!.payload as { message_th: string }).message_th;

    const view = (await (await createApp(h.deps).request(`/api/liff/orders/${o.id}`, { headers: { Authorization: `Bearer ${LIFF_TOKEN}` } })).json()) as any;
    expect(view.shopNote).toMatchObject({ text: note });

    await h.customerText('สถานะเป็นไงบ้างคะ');
    const first = h.line.lastReply();
    expect(JSON.stringify(first[0])).toContain('ข้อความจากร้าน');
    expect(JSON.stringify(first[0])).toContain(note.slice(0, 10));
    expect(first.length).toBeGreaterThan(1); // the normal reply is still there
    await h.customerText('สถานะเป็นไงบ้างคะ');
    expect(h.line.lastReplyText()).not.toContain('ข้อความจากร้าน'); // shown once only
    expect(h.line.pushes).toHaveLength(0);
  });

  it('a nearly spent day: all 3 still fire while today has budget, then wait for pull-on-message', async () => {
    const h = makeHarness(); // 2027-01-14 → 18 days left incl. today
    // 225 of 300 used (below the 80% warning): 285 − 225 = 60 left ÷ 18 days = 3 pushes today.
    await h.repo.insertQuotaLog({ month: '2027-01-01', limit_count: 300, total_usage: 225, local_count: 225, mode: 'NORMAL' });
    const o = await toPriceAwaiting(h);
    await h.ownerText(`${o.code} 900`);
    await h.customerPostback(`a=accept&o=${o.id}`);
    await h.ownerText(`${o.code} ship 100`);
    await h.customerImage('img-1', new Uint8Array(200).fill(9));
    await h.ownerText(`${o.code} paid`);
    await h.ownerText(`${o.code} track https://share.lalamove.com/abc`);
    expect(sentWhys(h)).toEqual(['PRICE_READY', 'TOTAL_READY', 'TRACKING_LINK']);
    // Budget for today now used: the next order's price quote waits (DAILY_BUDGET), not a silent drop.
    await h.customerText('หอยแครง 1 โล');
    await h.customerPostback(findPostback(h.line.lastReply(), 'new')); // A1 is still out for delivery
    await h.customerPostback(findPostback(h.line.lastReply(), 'confirm'));
    await h.customerLocation(13.7, 100.4, 'ร้าน');
    await h.ownerText(`${h.repo.orders.at(-1)!.code} 300`);
    expect(deferred(h).at(-1)).toMatchObject({ why: 'PRICE_READY', reason: 'DAILY_BUDGET' });
  });

  it('a sent push bumps the order version and broadcasts it (LIFF If-Match stays current)', async () => {
    const h = makeHarness();
    const o = await toPriceAwaiting(h);
    await h.ownerText(`${o.code} 900`);
    const row = h.repo.orders.at(-1)!;
    expect(row.push_count).toBe(1);
    expect(h.realtime.sent.at(-1)!.version).toBe(row.version);
  });

  it('LIFF open: all 3 still push, so each lands in the LINE chat history (production A19)', async () => {
    const h = makeHarness();
    const o = await toPriceAwaiting(h);
    const present = () => { h.repo.orders.find((x) => x.id === o.id)!.customer_last_seen_at = h.clock.now().toISOString(); };
    present();
    await h.ownerText(`${o.code} 900`);
    await h.customerPostback(`a=accept&o=${o.id}`);
    present();
    await h.ownerText(`${o.code} ship 100`);
    await h.customerImage('img-1', new Uint8Array(200).fill(9));
    await h.ownerText(`${o.code} paid`);
    present();
    await h.ownerText(`${o.code} track https://share.lalamove.com/abc`);
    expect(sentWhys(h)).toEqual(['PRICE_READY', 'TOTAL_READY', 'TRACKING_LINK']);
    expect(deferred(h).filter((d) => d.reason === 'PRESENT')).toEqual([]);
    expect(JSON.stringify(h.line.pushes.at(-1)!.messages)).toContain('https://share.lalamove.com/abc');
  });
});
