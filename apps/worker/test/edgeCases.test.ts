import { describe, expect, it } from 'vitest';
import { runScheduled, CRONS } from '../src/jobs';
import { findPostback, makeHarness, CUSTOMER_LINE } from './harness';

async function toAwaitingPayment(h: ReturnType<typeof makeHarness>) {
  await h.customerText('ปูม้า 1 โล');
  await h.customerPostback(findPostback(h.line.lastReply(), 'confirm'));
  await h.customerLocation(13.7, 100.4, 'บ้าน');
  await h.ownerText(`${h.repo.orders.at(-1)!.code} 900`);
  const o = h.repo.orders.at(-1)!;
  await h.customerPostback(`a=accept&o=${o.id}`);
  await h.ownerText(`${o.code} ship 100`);
}

describe('webhook safety', () => {
  it('rejects bad signatures and ignores redelivered events', async () => {
    const h = makeHarness();
    expect((await h.send(CUSTOMER_LINE, { type: 'follow' }, { badSig: true })).status).toBe(401);
    await h.send(CUSTOMER_LINE, { type: 'message', message: { id: 'x', type: 'text', text: 'ปู 1 โล' } }, { id: 'dup' });
    await h.send(CUSTOMER_LINE, { type: 'message', message: { id: 'x', type: 'text', text: 'ปู 1 โล' } }, { id: 'dup' });
    expect(h.repo.orders).toHaveLength(1);
    expect(h.line.replies).toHaveLength(1);
  });

  it('asks back when quantity is missing, then fills it from a bare "2 โล"', async () => {
    const h = makeHarness();
    await h.customerText('เอาหอยแครงค่ะ');
    expect(h.line.lastReplyText()).toContain('จำนวน');
    expect(h.repo.items).toHaveLength(0);
    await h.customerText('2 โล');
    expect(h.repo.items.map((i) => i.qty)).toEqual([2]);
    expect(h.line.lastReplyText()).toContain('สรุปออเดอร์');
  });
});

describe('owner commands', () => {
  it('works without a code when unambiguous, refuses when ambiguous', async () => {
    const h = makeHarness();
    await h.customerText('ปูม้า 1 โล');
    await h.customerPostback(findPostback(h.line.lastReply(), 'confirm'));
    await h.customerLocation(13.7, 100.4, 'บ้าน');
    await h.ownerText('900');
    expect(h.repo.orders[0]!.status).toBe('PRICE_QUOTED');
    expect(h.line.lastReplyText()).toContain('ไม่มีข้อมูลต้นทุน'); // no cost data → grey
    await h.ownerText('A99 ship 10');
    expect(h.line.lastReplyText()).toContain('ไม่พบออเดอร์ A99');
    await h.ownerText('A1 paid');
    expect(h.line.lastReplyText()).toContain('ใช้คำสั่งนี้ไม่ได้');
  });

  it('paid needs PASS unless the owner gives a reason', async () => {
    const h = makeHarness();
    await toAwaitingPayment(h);
    // Simulate a slip paid to someone else → RECEIVER check FAILs.
    const ai = h.deps.ai;
    h.deps.ai = {
      ...ai,
      parsePaymentSlip: async (args) => {
        const r = await ai.parsePaymentSlip(args);
        return r.ok ? { ...r, data: { ...r.data, receiver_name_or_id: 'นาย สมชาย ใ***' } } : r;
      },
    };
    await h.customerImage('slip-a', new Uint8Array(64).fill(1));
    const o = h.repo.orders.at(-1)!;
    expect(o.status).toBe('PAYMENT_REVIEW');
    expect(h.repo.payments.at(-1)!.check_result).toBe('FAIL');
    await h.ownerText(`${o.code} paid`);
    expect(h.repo.orders.at(-1)!.status).toBe('PAYMENT_REVIEW');
    await h.ownerText(`${o.code} paid! ลูกค้าโอนจากบัญชีบริษัท`);
    expect(h.repo.orders.at(-1)!.status).toBe('PAID');
    expect(h.repo.payments.at(-1)!.override_reason).toBe('ลูกค้าโอนจากบัญชีบริษัท');
  });

  it('owner note → AI draft is NOT sent until the owner taps Send', async () => {
    const h = makeHarness();
    await h.customerText('ปูม้า 1 โล');
    await h.customerPostback(findPostback(h.line.lastReply(), 'confirm'));
    await h.customerLocation(13.7, 100.4, 'บ้าน');
    await h.ownerText('A1 note ปูหมด มีกุ้งแม่น้ำ 900');
    expect(h.line.pushes).toHaveLength(0);
    expect(h.line.lastReplyText()).toContain('900 บาท');
    const send = findPostback(h.line.lastReply(), 'note_send');
    await h.send('Uowner0000000000000000000000000000', { type: 'postback', postback: { data: send } });
    expect(h.line.pushes).toHaveLength(1);
    expect(h.repo.events.some((e) => e.event === 'NOTE_APPROVED' && e.actor === 'owner')).toBe(true);
  });
});

describe('slips', () => {
  it('a reused slip (same reference) is flagged FAIL', async () => {
    const h = makeHarness();
    const img = new Uint8Array(64).fill(5);
    await toAwaitingPayment(h);
    await h.customerImage('s1', img);
    const first = h.repo.orders.at(-1)!;
    await h.ownerText(`${first.code} paid`);
    await h.ownerText(`${first.code} track https://share.lalamove.com/x`);
    await h.ownerText(`${first.code} done`);
    await toAwaitingPayment(h);
    await h.customerImage('s2', img);
    const p = h.repo.payments.at(-1)!;
    expect(p.check_result).toBe('FAIL');
    expect(p.reference_no).toBeNull();
    expect(JSON.stringify(p.check_details)).toContain('duplicate_reference');
  });

  it('two orders awaiting payment → customer chooses which order the slip is for', async () => {
    const h = makeHarness();
    await toAwaitingPayment(h);
    await h.customerText('หอยแครง 2 โล'); // second order while A1 awaits payment → new or add?
    await h.customerPostback(findPostback(h.line.lastReply(), 'new'));
    const second = h.repo.orders.at(-1)!;
    await h.customerPostback(findPostback(h.line.lastReply(), 'confirm'));
    await h.customerLocation(13.7, 100.4, 'ร้าน');
    await h.ownerText(`${second.code} 500`);
    await h.customerPostback(`a=accept&o=${second.id}`);
    await h.ownerText(`${second.code} ship 80`);
    await h.customerImage('s3', new Uint8Array(64).fill(7));
    expect(h.line.lastReplyText()).toContain('สลิปนี้สำหรับออเดอร์ไหน');
    await h.customerPostback(findPostback(h.line.lastReply(), 'slip_for').replace(/o=[^&]+/, `o=${second.id}`));
    expect(h.repo.orders.find((o) => o.id === second.id)!.status).toBe('PAYMENT_REVIEW');
    expect(h.repo.orders[0]!.status).toBe('AWAITING_PAYMENT');
  });
});

describe('quota guard', () => {
  it('no push when the customer is present in LIFF', async () => {
    const h = makeHarness();
    await h.customerText('ปูม้า 1 โล');
    await h.customerPostback(findPostback(h.line.lastReply(), 'confirm'));
    await h.customerLocation(13.7, 100.4, 'บ้าน');
    const o = h.repo.orders[0]!;
    await h.repo.updateOrder(o.id, o.version, { customer_last_seen_at: h.clock.now().toISOString() });
    await h.ownerText('900');
    expect(h.line.pushes).toHaveLength(0);
    expect(h.repo.events.find((e) => e.event === 'PUSH_DEFERRED')?.payload).toMatchObject({ reason: 'PRESENT' });
  });

  it('Quota Saver Mode halts pushes at 95%', async () => {
    const h = makeHarness();
    h.line.consumption = 285;
    await runScheduled(h.deps, CRONS.QUOTA);
    expect(h.repo.quotaLogs.at(-1)!.mode).toBe('QUOTA_SAVER');
    await h.customerText('ปูม้า 1 โล');
    await h.customerPostback(findPostback(h.line.lastReply(), 'confirm'));
    await h.customerLocation(13.7, 100.4, 'บ้าน');
    await h.ownerText('900');
    expect(h.line.pushes).toHaveLength(0);
    expect(h.repo.events.find((e) => e.event === 'PUSH_DEFERRED')?.payload).toMatchObject({ reason: 'QUOTA_SAVER' });
  });
});

describe('timers never move money forward', () => {
  it('expires payment, reminds owner, abandons idle pre-payment orders but never AWAITING_PRICE', async () => {
    const h = makeHarness();
    await toAwaitingPayment(h);                       // order A1 awaiting payment
    await h.customerText('หอยแครง 1 โล');              // second order → new
    await h.customerPostback(findPostback(h.line.lastReply(), 'new'));
    await h.customerPostback(findPostback(h.line.lastReply(), 'confirm'));
    await h.customerLocation(13.7, 100.4, 'ร้าน');    // A2 awaiting price
    h.clock.advance(46);
    await runScheduled(h.deps, CRONS.EVERY_MINUTE);
    const [a1, a2] = h.repo.orders;
    expect(a1!.status).toBe('PAYMENT_EXPIRED');
    expect(a2!.owner_reminded_at).not.toBeNull();
    expect(h.notifier.alerts.map((a) => a.kind)).toEqual(expect.arrayContaining(['PAYMENT_EXPIRED', 'OWNER_TIMEOUT']));
    expect(h.line.pushes).toHaveLength(1); // only the price-ready push from A1; timers never push
    h.clock.advance(25 * 60);
    await runScheduled(h.deps, CRONS.EVERY_MINUTE);
    expect(h.repo.orders[0]!.status).toBe('CANCELLED');   // expired + idle 24h
    expect(h.repo.orders[1]!.status).toBe('AWAITING_PRICE'); // owner offline ≠ auto-cancel
  });
});
