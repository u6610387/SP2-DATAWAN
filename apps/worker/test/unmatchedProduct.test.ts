import { describe, expect, it } from 'vitest';
import { makeHarness } from './harness';

// Regression for production order A2: "กุ้ง 2 โล" matched no catalog alias, so the order was
// created with 0 items and needs_owner_review=false — the owner was never told, and the
// customer was stuck on "ต้องการสินค้าอะไรคะ".
describe('order intent with no recognised product', () => {
  it('flags the order for owner review and alerts the owner once', async () => {
    const h = makeHarness();
    await h.customerText('กุ้ง 2 โล');

    const order = h.repo.orders.at(-1)!;
    expect(h.repo.items.filter((i) => i.order_id === order.id)).toHaveLength(0);
    expect(order.needs_owner_review).toBe(true);
    const alerts = h.notifier.alerts.filter((a) => a.kind === 'NEEDS_REVIEW');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ orderId: order.id, code: order.code });

    // Customer answers the clarification with another unrecognised product word: no second alert.
    await h.customerText('กุ้งตัวใหญ่ 2 โล');
    expect(h.notifier.alerts.filter((a) => a.kind === 'NEEDS_REVIEW')).toHaveLength(1);
    expect(h.repo.orders.at(-1)!.needs_owner_review).toBe(true);
  });

  it('does not flag a recognised product (alias ปู → ปูม้า)', async () => {
    const h = makeHarness();
    await h.customerText('ปูม้า 1 โล');
    expect(h.repo.orders.at(-1)!.needs_owner_review).toBe(false);
    expect(h.notifier.alerts.filter((a) => a.kind === 'NEEDS_REVIEW')).toHaveLength(0);
  });

  it('does not flag a normal order', async () => {
    const h = makeHarness();
    await h.customerText('หอยแครง 2 โล');
    expect(h.repo.orders.at(-1)!.needs_owner_review).toBe(false);
    expect(h.notifier.alerts.filter((a) => a.kind === 'NEEDS_REVIEW')).toHaveLength(0);
  });
});
