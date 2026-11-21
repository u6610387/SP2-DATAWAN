/**
 * UI-chrome dictionary type for apps/web only — labels, buttons, status badges, empty states.
 * NOT the LINE bot's Thai strings (packages/shared/src/i18n/th.ts stays Thai-only per
 * seafood-domain-rules); this only covers the dashboard/LIFF web UI. Business data coming back
 * from the API (Lalamove card text, slip check details, raw order text, customer names) is
 * backend-owned Thai content and is never re-translated client-side.
 */
import type { OrderStatus } from '@datawan/shared';

export interface Dictionary {
  common: {
    brand: string;
    loading: string;
    error: string;
    tryAgain: string;
    copy: string;
  };
  nav: {
    home: string;
    inventory: string;
  };
  login: {
    title: string;
    email: string;
    password: string;
    submit: string;
    submitting: string;
    error: string;
  };
  dashboard: {
    salesToday: string;
    delivered: string;
    productRevenue: string;
    shipping: string;
    grossMargin: string;
    quotaTitle: string;
    quotaWarning: string;
    quotaSaver: string;
    profit: string;
    loss: string;
    needsReview: string;
    noOpenOrders: string;
  };
  orderDetail: {
    back: string;
    notFound: string;
    items: string;
    weighed: (qty: string) => string;
    needsReviewWarning: string;
    priceTitle: string;
    cost: (amount: string) => string;
    suggested: (amount: string) => string;
    b2bAnchor: (amount: string) => string;
    pricePlaceholder: string;
    notePlaceholder: string;
    confirmPrice: string;
    negotiationTitle: string;
    accept: string;
    hold: string;
    counterPlaceholder: string;
    counterSend: string;
    shippingTitle: string;
    shippingPlaceholder: string;
    confirmShipping: string;
    lalamoveTitle: string;
    awaitingPaymentTitle: string;
    expiresAt: (time: string) => string;
    paymentTitle: string;
    slipAmount: (amount: string) => string;
    overrideReasonPlaceholder: string;
    confirmPayment: string;
    rejectSlip: string;
    rejectReasonFallback: string;
    dispatchTitle: string;
    trackingPlaceholder: string;
    dispatchSubmit: string;
    deliveringTitle: string;
    markDelivered: string;
    deliveredTitle: string;
    deliveredSummary: (total: string) => string;
  };
  inventory: {
    title: string;
    reasonStockIn: string;
    reasonWaste: string;
    reasonAdjust: string;
    qtyPlaceholder: string;
    unitCostPlaceholder: string;
    notePlaceholder: string;
    save: string;
  };
  liff: {
    orderLabel: (code: string) => string;
    loggingIn: string;
    loginError: (msg: string) => string;
    notFound: string;
    genericError: string;
    items: string;
    deliverTo: (addr: string) => string;
    ownerDelayed: string;
    awaitingPrice: string;
    priceTitle: string;
    acceptBtn: string;
    counterBtn: string;
    counterPlaceholder: string;
    counterSend: string;
    negotiatingTitle: string;
    negotiatingBody: string;
    amountDueTitle: string;
    uploadSlip: string;
    uploading: string;
    uploadError: string;
    expiredTitle: string;
    expiredBody: string;
    reviewTitle: string;
    reviewBody: string;
    paidTitle: string;
    deliveringTitle: string;
    trackLink: string;
    deliveredTitle: string;
  };
  pushButton: {
    enable: string;
  };
  orderStatus: Record<OrderStatus, string>;
}
