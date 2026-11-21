/**
 * src/mocks/handlers.ts is what lets the dashboard/LIFF UI run with NEXT_PUBLIC_USE_MOCKS=true
 * and no Worker running — these tests prove its view-model shaping and state transitions are
 * actually correct, not just "doesn't throw". Each test reloads the module fresh (vi.resetModules)
 * since mockOrders is shared, mutable module state.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomerOrderView, OwnerOrderView } from '@datawan/shared';
import type { mockFetch as MockFetch } from '../src/mocks/handlers';

let mockFetch: typeof MockFetch;

beforeEach(async () => {
  vi.resetModules();
  ({ mockFetch } = await import('../src/mocks/handlers'));
});

describe('mockFetch', () => {
  it('lists orders and fetches a single order detail', async () => {
    const list = await mockFetch<OwnerOrderView[]>('/api/owner/orders', { method: 'GET' });
    expect(list.length).toBeGreaterThan(0);

    const one = await mockFetch<OwnerOrderView>(`/api/owner/orders/${list[0]!.id}`, { method: 'GET' });
    expect(one.id).toBe(list[0]!.id);
  });

  it('404s for an order id that does not exist', async () => {
    await expect(mockFetch('/api/owner/orders/does-not-exist', { method: 'GET' })).rejects.toMatchObject({ status: 404 });
  });

  it('setting a price moves AWAITING_PRICE to PRICE_QUOTED with the right margin color', async () => {
    const view = await mockFetch<OwnerOrderView>('/api/owner/orders/order-1/price', {
      method: 'POST',
      body: { amountSatang: 185_000, note: 'กุ้งได้ 2.1 กก.' },
    });
    expect(view.status).toBe('PRICE_QUOTED');
    expect(view.productPriceSatang).toBe(185_000);
    expect(view.priceNote).toBe('กุ้งได้ 2.1 กก.');
    // order-1's costSatang fixture is 135000 → margin = 50000, GREEN
    expect(view.marginSatang).toBe(50_000);
    expect(view.marginColor).toBe('GREEN');
  });

  it('negotiation accept moves to AWAITING_SHIPPING_FEE and adopts the customer counter amount', async () => {
    await mockFetch('/api/liff/orders/order-2/counter', { method: 'POST', body: { amountSatang: 100_000 } });
    const view = await mockFetch<OwnerOrderView>('/api/owner/orders/order-2/negotiation', { method: 'POST', body: { action: 'accept' } });
    expect(view.status).toBe('AWAITING_SHIPPING_FEE');
    expect(view.productPriceSatang).toBe(100_000);
  });

  it('shipping sets the total and a PromptPay payload', async () => {
    await mockFetch('/api/liff/orders/order-2/counter', { method: 'POST', body: { amountSatang: 100_000 } });
    await mockFetch('/api/owner/orders/order-2/negotiation', { method: 'POST', body: { action: 'accept' } });
    const view = await mockFetch<OwnerOrderView>('/api/owner/orders/order-2/shipping', { method: 'POST', body: { feeSatang: 10_000 } });
    expect(view.status).toBe('AWAITING_PAYMENT');
    expect(view.totalSatang).toBe(110_000);
    expect(view.promptpayPayload).toBeTruthy();
  });

  it('the LIFF customer view never includes cost or margin fields', async () => {
    const view = await mockFetch<CustomerOrderView>('/api/liff/orders/order-2', { method: 'GET' });
    expect(view).not.toHaveProperty('costSatang');
    expect(view).not.toHaveProperty('marginColor');
    expect(view).not.toHaveProperty('latestPayment');
    expect(view.realtime.channel).toContain('order-2');
  });

  it('stock POST adjusts onHand, reflected in a subsequent GET', async () => {
    const before = await mockFetch<{ productId: string; onHand: number }[]>('/api/owner/stock', { method: 'GET' });
    const onHandBefore = before.find((s) => s.productId === 'p-kung')!.onHand; // snapshot the primitive — the mock store returns live references
    await mockFetch('/api/owner/stock', { method: 'POST', body: { productId: 'p-kung', reason: 'stock_in', qtyDelta: 5 } });
    const after = await mockFetch<{ productId: string; onHand: number }[]>('/api/owner/stock', { method: 'GET' });
    expect(after.find((s) => s.productId === 'p-kung')!.onHand).toBe(onHandBefore + 5);
  });
});
