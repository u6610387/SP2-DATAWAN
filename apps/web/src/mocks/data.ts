/**
 * Fixture data for NEXT_PUBLIC_USE_MOCKS=true — lets the dashboard and LIFF order room run
 * against realistic view-model data without the Worker/Supabase/LINE running
 * (docs/API_AND_AI_CONTRACTS.md §7 "mock the Worker API" strategy, Part 2 of CLAUDE.md).
 */
import type { OwnerOrderView, QuotaStatus } from '@datawan/shared';

function order(partial: Partial<OwnerOrderView> & Pick<OwnerOrderView, 'id' | 'code' | 'status'>): OwnerOrderView {
  return {
    version: 1,
    items: [],
    productPriceSatang: null,
    priceNote: null,
    shippingFeeSatang: null,
    totalSatang: null,
    paymentExpiresAt: null,
    promptpayPayload: null,
    trackingUrl: null,
    negotiation: [],
    delivery: { recipientName: null, recipientPhone: null, hasLocation: false, needsRecipient: false, addressText: null, lat: null, lng: null, requestedDeliveryAt: null },
    ownerDelayed: false,
    customer: { id: 'u1', type: 'B2C', name: 'คุณสมหญิง', businessName: null, phone: '0812345678' },
    rawOrderText: null,
    costSatang: null,
    suggestedPriceSatang: null,
    b2bAnchorPriceSatang: null,
    marginSatang: null,
    marginColor: 'GREY',
    latestPayment: null,
    lalamoveCard: null,
    needsOwnerReview: false,
    pushCount: 0,
    trackingPush: null,
    ...partial,
  };
}

export const mockOrders: OwnerOrderView[] = [
  order({
    id: 'order-1',
    code: 'A1',
    status: 'AWAITING_PRICE',
    items: [{ id: 'i1', productId: 'p-kung', name: 'กุ้งแม่น้ำ', qty: 2, unit: 'kg', prepType: 'live', actualQty: null }],
    delivery: { recipientName: 'คุณสมหญิง', recipientPhone: '0812345678', hasLocation: true, needsRecipient: false, addressText: 'ตลาดสดธนบุรี', lat: 13.7234, lng: 100.4761, requestedDeliveryAt: '2027-01-15T07:00:00+07:00' },
    costSatang: 135000,
    suggestedPriceSatang: 169000,
  }),
  order({
    id: 'order-2',
    code: 'A2',
    status: 'PRICE_QUOTED',
    items: [{ id: 'i2', productId: 'p-pu', name: 'ปูม้า', qty: 1.5, unit: 'kg', prepType: 'chilled', actualQty: null }],
    productPriceSatang: 120000,
    costSatang: 90000,
    marginSatang: 30000,
    marginColor: 'GREEN',
    negotiation: [{ round: 1, actor: 'owner', action: 'quote', amountSatang: 120000, message: null }],
  }),
  order({
    id: 'order-3',
    code: 'A3',
    status: 'AWAITING_PAYMENT',
    items: [{ id: 'i3', productId: 'p-hoi', name: 'หอยแครง', qty: 3, unit: 'kg', prepType: 'live', actualQty: null }],
    productPriceSatang: 45000,
    costSatang: 27000,
    marginSatang: 18000,
    marginColor: 'GREEN',
    shippingFeeSatang: 8000,
    totalSatang: 53000,
    promptpayPayload: '00020101021129370016A000000677010111011300668123456785802TH530376454062530.005303764630417B4',
    paymentExpiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
    delivery: { recipientName: 'คุณบี', recipientPhone: '021234567', hasLocation: true, needsRecipient: false, addressText: '123 ถ.เจริญนคร', lat: 13.72, lng: 100.49, requestedDeliveryAt: null },
    lalamoveCard: { text: '📦 A3 — Lalamove\nผู้รับ: คุณบี\nโทร: 0898765432\nที่อยู่: 123 ถ.เจริญนคร', mapUrl: 'https://www.google.com/maps/search/?api=1&query=13.72,100.49' },
  }),
  order({
    id: 'order-4',
    code: 'A4',
    status: 'PAYMENT_REVIEW',
    items: [{ id: 'i4', productId: 'p-kung', name: 'กุ้งแม่น้ำ', qty: 1, unit: 'kg', prepType: 'live', actualQty: null }],
    productPriceSatang: 85000,
    costSatang: 60000,
    marginSatang: 25000,
    marginColor: 'GREEN',
    shippingFeeSatang: 6000,
    totalSatang: 91000,
    latestPayment: {
      id: 'pay-1',
      result: 'PASS',
      checks: [
        { rule: 'AMOUNT', result: 'PASS', detail: 'ยอดตรง ฿910' },
        { rule: 'RECEIVER', result: 'PASS', detail: 'ผู้รับตรงกับร้าน' },
        { rule: 'REFERENCE', result: 'PASS', detail: 'เลขอ้างอิงไม่ซ้ำ' },
      ],
      extracted: { is_slip: true, bank: 'KBANK', amount: 910, date_time: new Date().toISOString(), receiver_name_or_id: 'ดา ท***', reference_no: 'MOCKAB12' },
      slipImageUrl: null,
    },
  }),
];

export const mockQuota: QuotaStatus = {
  month: '2027-01',
  limit: 300,
  used: 42,
  mode: 'NORMAL',
  dailyBudgetRemaining: 9,
  resetsAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
};

export const mockStock = [
  { productId: 'p-kung', nameTh: 'กุ้งแม่น้ำ', unit: 'kg', onHand: 8 },
  { productId: 'p-pu', nameTh: 'ปูม้า', unit: 'kg', onHand: 5.5 },
  { productId: 'p-hoi', nameTh: 'หอยแครง', unit: 'kg', onHand: 12 },
];

export const mockSummary = {
  ordersDelivered: 3,
  productRevenueSatang: 450000,
  shippingCollectedSatang: 36000,
  grossMarginSatang: 120000,
};
