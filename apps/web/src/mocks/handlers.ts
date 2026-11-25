/** Mock Worker API — path/method matching over the fixtures in ./data (NEXT_PUBLIC_USE_MOCKS=true). */
import { computeMargin, type CustomerOrderView, type NegotiationView, type OwnerOrderView } from '@datawan/shared';
import { ApiRequestError, type RequestOptions } from '../lib/api';
import { mockOrders, mockQuota, mockStock, mockSummary } from './data';

function findOrder(id: string): OwnerOrderView {
  const o = mockOrders.find((x) => x.id === id);
  if (!o) throw new ApiRequestError(404, 'NOT_FOUND', `order ${id} not found`);
  return o;
}

function toCustomerView(o: OwnerOrderView): CustomerOrderView {
  const { customer, rawOrderText, costSatang, suggestedPriceSatang, b2bAnchorPriceSatang, marginSatang, marginColor, latestPayment, lalamoveCard, needsOwnerReview, pushCount, ...rest } = o;
  void customer;
  void rawOrderText;
  void costSatang;
  void suggestedPriceSatang;
  void b2bAnchorPriceSatang;
  void marginSatang;
  void marginColor;
  void latestPayment;
  void lalamoveCard;
  void needsOwnerReview;
  void pushCount;
  return { ...rest, realtime: { channel: `order:${o.id}:mock` } };
}

function nextRound(o: OwnerOrderView): number {
  return o.negotiation.length + 1;
}
function pushNegotiation(o: OwnerOrderView, n: Omit<NegotiationView, 'round'>) {
  o.negotiation = [...o.negotiation, { round: nextRound(o), ...n }];
}

function applyPrice(o: OwnerOrderView, body: { amountSatang: number; note?: string | null }) {
  const wasNegotiating = o.status === 'NEGOTIATING';
  o.productPriceSatang = body.amountSatang;
  o.priceNote = body.note ?? null;
  const m = computeMargin(body.amountSatang, [o.costSatang]);
  o.marginSatang = m.marginSatang;
  o.marginColor = m.color;
  o.status = 'PRICE_QUOTED';
  pushNegotiation(o, { actor: 'owner', action: wasNegotiating ? 'counter' : 'quote', amountSatang: body.amountSatang, message: body.note ?? null });
}

function applyNegotiation(o: OwnerOrderView, body: { action: 'accept' | 'counter' | 'hold'; amountSatang?: number }) {
  if (body.action === 'accept') {
    const last = [...o.negotiation].reverse().find((n) => n.actor === 'customer' && n.action === 'counter');
    if (last?.amountSatang != null) o.productPriceSatang = last.amountSatang;
    o.status = 'AWAITING_SHIPPING_FEE';
    pushNegotiation(o, { actor: 'owner', action: 'accept', amountSatang: o.productPriceSatang, message: null });
  } else if (body.action === 'hold') {
    o.status = 'PRICE_QUOTED';
    pushNegotiation(o, { actor: 'owner', action: 'hold', amountSatang: o.productPriceSatang, message: null });
  } else if (body.action === 'counter' && body.amountSatang) {
    o.productPriceSatang = body.amountSatang;
    o.status = 'PRICE_QUOTED';
    pushNegotiation(o, { actor: 'owner', action: 'counter', amountSatang: body.amountSatang, message: null });
  }
}

function applyShipping(o: OwnerOrderView, body: { feeSatang: number }) {
  o.shippingFeeSatang = body.feeSatang;
  o.totalSatang = (o.productPriceSatang ?? 0) + body.feeSatang;
  o.status = 'AWAITING_PAYMENT';
  o.paymentExpiresAt = new Date(Date.now() + 45 * 60_000).toISOString();
  o.promptpayPayload = '00020101021129370016A000000677010111011300668123456785802TH53037645406' + (o.totalSatang / 100).toFixed(2);
  o.lalamoveCard = {
    text: [`📦 ${o.code} — Lalamove`, ...(o.delivery.recipientName ? [`ผู้รับ: ${o.delivery.recipientName}`] : []), ...(o.delivery.recipientPhone ? [`โทร: ${o.delivery.recipientPhone}`] : []), ...(o.delivery.recipientName && o.delivery.recipientPhone ? [] : ['⚠️ ยังไม่มีชื่อ/เบอร์ผู้รับ']), `ที่อยู่: ${o.delivery.addressText ?? '(ดูจากหมุด)'}`].join('\n'),
    mapUrl: o.delivery.lat !== null && o.delivery.lng !== null ? `https://www.google.com/maps/search/?api=1&query=${o.delivery.lat},${o.delivery.lng}` : null,
  };
}

function countByStatus(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of mockOrders) if (o.status !== 'DELIVERED' && o.status !== 'CANCELLED') out[o.status] = (out[o.status] ?? 0) + 1;
  return out;
}

export async function mockFetch<T>(path: string, opts: RequestOptions): Promise<T> {
  await new Promise((r) => setTimeout(r, 120)); // feel async in the UI
  const method = opts.method ?? 'GET';
  const body = opts.body as Record<string, unknown> | undefined;

  if (path === '/api/owner/summary/today') return { ...mockSummary, openByStatus: countByStatus() } as T;
  if (path === '/api/owner/quota') return mockQuota as T;
  if (path === '/api/owner/orders' && method === 'GET') return mockOrders as unknown as T;
  if (path === '/api/owner/stock' && method === 'GET') return mockStock as unknown as T;
  if (path === '/api/owner/stock' && method === 'POST') {
    const row = mockStock.find((s) => s.productId === body?.productId);
    if (row) row.onHand += Number(body?.qtyDelta ?? 0);
    return { stockLogId: `mock-${Date.now()}` } as T;
  }
  if (path === '/api/owner/push-subscriptions') return undefined as T;

  const ownerOrderMatch = /^\/api\/owner\/orders\/([^/]+)(\/.*)?$/.exec(path);
  if (ownerOrderMatch) {
    const o = findOrder(ownerOrderMatch[1]!);
    const action = ownerOrderMatch[2];
    if (!action) return o as unknown as T;
    if (action === '/price') { applyPrice(o, body as { amountSatang: number; note?: string | null }); return o as unknown as T; }
    if (action === '/negotiation') { applyNegotiation(o, body as { action: 'accept' | 'counter' | 'hold'; amountSatang?: number }); return o as unknown as T; }
    if (action === '/shipping') { applyShipping(o, body as { feeSatang: number }); return o as unknown as T; }
    if (action === '/dispatch') { o.status = 'DELIVERING'; o.trackingUrl = String(body?.trackingUrl ?? ''); return o as unknown as T; }
    if (action === '/delivered') { o.status = 'DELIVERED'; return o as unknown as T; }
    if (action === '/cancel') { o.status = 'CANCELLED'; return o as unknown as T; }
  }

  const paymentMatch = /^\/api\/owner\/payments\/([^/]+)\/(confirm|reject)$/.exec(path);
  if (paymentMatch) {
    const o = mockOrders.find((x) => x.latestPayment?.id === paymentMatch[1]);
    if (!o) throw new ApiRequestError(404, 'NOT_FOUND', 'payment not found');
    if (paymentMatch[2] === 'confirm') {
      o.status = 'PAID';
    } else {
      o.status = 'AWAITING_PAYMENT';
      o.latestPayment = null;
    }
    return o as unknown as T;
  }

  const liffOrderMatch = /^\/api\/liff\/orders\/([^/]+)(\/.*)?$/.exec(path);
  if (liffOrderMatch) {
    const o = findOrder(liffOrderMatch[1]!);
    const action = liffOrderMatch[2];
    if (!action) return toCustomerView(o) as unknown as T;
    if (action === '/accept') { o.status = 'AWAITING_SHIPPING_FEE'; return toCustomerView(o) as unknown as T; }
    if (action === '/counter') {
      const amountSatang = Number(body?.amountSatang);
      o.status = 'NEGOTIATING';
      pushNegotiation(o, { actor: 'customer', action: 'counter', amountSatang, message: (body?.message as string | null) ?? null });
      return toCustomerView(o) as unknown as T;
    }
    if (action === '/slip-upload-url') return { uploadUrl: 'about:blank', path: `slips/${o.id}/mock.jpg` } as T;
    if (action === '/slip') {
      o.status = 'PAYMENT_REVIEW';
      o.latestPayment = { id: `pay-mock-${o.id}`, result: 'PASS', checks: [], extracted: null, slipImageUrl: null };
      return toCustomerView(o) as unknown as T;
    }
    if (action === '/heartbeat') return undefined as T;
  }

  throw new ApiRequestError(404, 'NOT_FOUND', `no mock handler for ${method} ${path}`);
}
