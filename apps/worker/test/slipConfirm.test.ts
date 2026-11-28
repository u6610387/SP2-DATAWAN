/** Owner slip confirm (2026-11-29): look at the slip and tap. A reason only for a FAIL, or to reject. */
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { applyEvent } from '../src/services/orders';
import { findPostback, makeHarness, OWNER_TOKEN } from './harness';

async function slipInReview(checks: { rule: string; result: string; detail: string }[], result: 'WARN' | 'FAIL') {
  const h = makeHarness();
  await h.customerText('ปูม้า 1 โล');
  await h.customerPostback(findPostback(h.line.lastReply(), 'confirm'));
  await h.customerLocation(13.7, 100.4, 'บ้าน');
  const o = h.repo.orders[0]!;
  await h.ownerText(`${o.code} 900`);
  await h.customerPostback(`a=accept&o=${o.id}`);
  await h.ownerText(`${o.code} ship 100`);
  await h.repo.insertPayment({
    order_id: o.id, slip_path: `slips/${o.id}/s.jpeg`, ai_extract: null, amount_satang: null, slip_time: null, receiver_text: null, reference_no: null,
    check_result: result, check_details: { ai: 'MANUAL', checks },
  });
  await applyEvent(h.deps, h.repo.orders[0]!, 'SLIP_UPLOADED', 'customer', {}, { result });
  return { h, code: o.code, paymentId: h.repo.payments[0]!.id, app: createApp(h.deps) };
}
const post = (body: unknown) => ({ method: 'POST', headers: { Authorization: `Bearer ${OWNER_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const MANUAL = [{ rule: 'READABLE', result: 'WARN', detail: 'manual' }, { rule: 'REFERENCE', result: 'PASS', detail: 'qr ok' }];

describe('owner slip confirm', () => {
  it('manual-mode WARN: the LINE "paid" command confirms with no reason', async () => {
    const { h, code } = await slipInReview(MANUAL, 'WARN');
    await h.ownerText(`${code} paid`);
    expect(h.repo.orders[0]!.status).toBe('PAID');
    expect(h.repo.payments[0]).toMatchObject({ override_reason: null, confirmed_by: expect.any(String) });
    expect(h.repo.events.find((e) => e.event === 'OWNER_CONFIRM_PAYMENT')).toMatchObject({ actor: 'owner', payload: { check_result: 'WARN', checks: ['READABLE:WARN', 'REFERENCE:PASS'] } });
  });

  it('duplicate QR (FAIL): no confirm without a reason; with one, recorded', async () => {
    const { h, code, paymentId, app } = await slipInReview([{ rule: 'REFERENCE', result: 'FAIL', detail: 'สลิปซ้ำ' }], 'FAIL');
    let res = await app.request(`/api/owner/payments/${paymentId}/confirm`, post({}));
    expect(res.status).toBe(422);
    await h.ownerText(`${code} paid`);
    expect(h.repo.orders[0]!.status).toBe('PAYMENT_REVIEW');
    res = await app.request(`/api/owner/payments/${paymentId}/confirm`, post({ overrideReason: 'ลูกค้าโอนซ้ำ คืนเงินแล้ว' }));
    expect(res.status).toBe(200);
    expect(h.repo.payments[0]!.override_reason).toBe('ลูกค้าโอนซ้ำ คืนเงินแล้ว');
  });

  it('rejecting a slip needs a reason', async () => {
    const { h, paymentId, app } = await slipInReview(MANUAL, 'WARN');
    expect((await app.request(`/api/owner/payments/${paymentId}/reject`, post({ reason: '  ' }))).status).toBe(400);
    expect(h.repo.orders[0]!.status).toBe('PAYMENT_REVIEW');
    expect((await app.request(`/api/owner/payments/${paymentId}/reject`, post({ reason: 'ยอดไม่ตรง' }))).status).toBe(200);
    expect(h.repo.orders[0]!.status).toBe('AWAITING_PAYMENT');
  });
});
