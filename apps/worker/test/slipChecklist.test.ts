/** Manual slip mode: the owner's checklist (amount, receiver, time) gates ยืนยันรับเงิน. */
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { applyEvent } from '../src/services/orders';
import { findPostback, makeHarness, OWNER_TOKEN } from './harness';

/* eslint-disable @typescript-eslint/no-explicit-any */
async function manualSlipInReview() {
  const h = makeHarness();
  await h.customerText('ปูม้า 1 โล');
  await h.customerPostback(findPostback(h.line.lastReply(), 'confirm'));
  await h.customerLocation(13.7, 100.4, 'บ้าน');
  const o = h.repo.orders[0]!;
  await h.ownerText(`${o.code} 900`);
  await h.customerPostback(`a=accept&o=${o.id}`);
  await h.ownerText(`${o.code} ship 100`);
  // What manual mode stores: nothing read the slip; the dashboard's QR check passed.
  await h.repo.insertPayment({
    order_id: o.id, slip_path: `slips/${o.id}/s.jpeg`, ai_extract: null, amount_satang: null, slip_time: null, receiver_text: null, reference_no: 'REF-A19', check_result: 'WARN',
    check_details: { ai: 'MANUAL', checks: [{ rule: 'READABLE', result: 'WARN', detail: 'manual' }, { rule: 'REFERENCE', result: 'PASS', detail: 'qr ok' }] },
  });
  await applyEvent(h.deps, h.repo.orders[0]!, 'SLIP_UPLOADED', 'customer', {}, { result: 'WARN' });
  return { h, o: h.repo.orders[0]!, paymentId: h.repo.payments[0]!.id, app: createApp(h.deps) };
}

const post = (body: unknown) => ({ method: 'POST', headers: { Authorization: `Bearer ${OWNER_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('slip checklist (manual mode)', () => {
  it('REFERENCE · PASS alone can no longer confirm: the checklist is required (REST and LINE command)', async () => {
    const { h, o, paymentId, app } = await manualSlipInReview();
    let res = await app.request(`/api/owner/payments/${paymentId}/confirm`, post({ overrideReason: 'ok' }));
    expect(res.status).toBe(422);
    expect((await res.json() as any).error.code).toBe('SLIP_CHECKLIST_REQUIRED');
    await h.ownerText(`${o.code} paid! ตรวจแล้ว`);
    expect(h.line.lastReplyText()).toContain('กรุณายืนยันรับเงินในแดชบอร์ด');
    expect(h.repo.orders[0]!.status).toBe('PAYMENT_REVIEW');
    res = await app.request(`/api/owner/payments/${paymentId}/confirm`, post({ slipChecklist: { amountSatang: 100000, receiverIsShop: true, slipTime: h.clock.now().toISOString() } }));
    expect(res.status).toBe(200);
    expect(h.repo.payments[0]).toMatchObject({ check_result: 'PASS', override_reason: null });
  });

  it('a mismatch needs a typed reason, and the override is recorded with the FAILs', async () => {
    const { h, paymentId, app } = await manualSlipInReview();
    const wrong = { amountSatang: 10500, receiverIsShop: false, slipTime: new Date(h.repo.orders[0]!.created_at).toISOString() };
    let res = await app.request(`/api/owner/payments/${paymentId}/confirm`, post({ slipChecklist: wrong }));
    expect(res.status).toBe(422);
    expect((await res.json() as any).error.message).toMatch(/AMOUNT FAIL.*RECEIVER FAIL/);
    res = await app.request(`/api/owner/payments/${paymentId}/confirm`, post({ slipChecklist: wrong, overrideReason: 'ลูกค้าโอนสองรอบ' }));
    expect(res.status).toBe(200);
    expect(h.repo.payments[0]).toMatchObject({ check_result: 'FAIL', override_reason: 'ลูกค้าโอนสองรอบ' });
    const ev = h.repo.events.find((e) => e.event === 'OWNER_CONFIRM_PAYMENT')!;
    expect(ev.actor).toBe('owner');
    expect(ev.payload).toMatchObject({ check_result: 'FAIL', checks: expect.arrayContaining(['AMOUNT:FAIL', 'RECEIVER:FAIL', 'REFERENCE:PASS']) });
  });
});
