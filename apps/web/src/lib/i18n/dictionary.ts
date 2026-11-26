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
    /** 409: the order changed since this screen loaded; the screen has been refreshed. */
    orderChanged: string;
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
    quotaNormal: string;
    quotaWarningBadge: string;
    quotaSaverBadge: string;
    quotaWarning: string;
    quotaSaver: string;
    profit: string;
    loss: string;
    needsReview: string;
    noOpenOrders: string;
  };
  orderDetail: {
    back: string;
    backAria: string;
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
    marginUnknown: string;
    marginProfit: (amount: string, pct: string) => string;
    marginLoss: (amount: string, pct: string) => string;
    negotiationTitle: string;
    customerOffered: string;
    accept: string;
    hold: string;
    counterPlaceholder: string;
    counterSend: string;
    shippingTitle: string;
    shippingPlaceholder: string;
    confirmShipping: string;
    shippingCorrectTitle: string;
    shippingCorrectHint: (current: string) => string;
    lalamoveTitle: string;
    lalamovePin: string;
    lalamoveOpenMap: string;
    lalamoveName: string;
    lalamovePhone: string;
    lalamovePhoneHint: (digits: string) => string;
    lalamoveAddress: string;
    lalamoveCopyAll: string;
    lalamoveCopied: string;
    lalamoveMissing: string;
    awaitingPaymentTitle: string;
    expiresAt: (time: string) => string;
    paymentTitle: string;
    slipAmount: (amount: string) => string;
    slipImageAlt: string;
    slipOpenFull: string;
    slipImageMissing: string;
    slipImageError: string;
    slipQrChecking: string;
    slipQrError: string;
    slipQrRecheck: string;
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
    trackingPushSent: string;
    trackingPushDeferred: (why: string) => string;
    trackingPushReasons: Record<'PRESENT' | 'ORDER_CAP' | 'QUOTA_SAVER' | 'WARNING_P2' | 'DAILY_BUDGET' | 'INACTIVE_USER', string>;
    trackingExtracted: (url: string) => string;
    trackingNoLink: string;
    waitingDeliveryTitle: string;
    waitingDeliveryBody: string;
    cancelOrder: string;
    cancelTitle: string;
    cancelHint: string;
    cancelReasonPlaceholder: string;
    cancelConfirm: string;
    cancelBack: string;
    cancelledTitle: string;
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
  catalog: {
    addCategoryButton: string;
    addProductButton: string;
    addCategory: string;
    addProduct: string;
    categoryName: string;
    categoryPlaceholder: string;
    productName: string;
    productPlaceholder: string;
    unit: string;
    units: Record<'kg' | 'piece' | 'box' | 'tray' | 'set', string>;
    category: string;
    noCategory: string;
    emptyCategory: string;
    prepTypes: string;
    preps: Record<'live' | 'chilled' | 'frozen' | 'cooked' | 'any', string>;
    aliases: string;
    aliasesPlaceholder: string;
    aliasesHint: string;
    save: string;
    cancel: string;
    categoryAdded: (name: string) => string;
    autoCategory: (category: string) => string;
    moveToCategory: string;
    editProduct: string;
    openForSale: string;
    closedForSale: string;
    productMoved: (name: string, category: string) => string;
    productMerged: (name: string, category: string) => string;
    productSaved: (name: string) => string;
    productAdded: (name: string) => string;
  };
  liff: {
    orderLabel: (code: string) => string;
    loggingIn: string;
    /** /liff endpoint page while LIFF forwards to the order room (liff.state present). */
    openingOrder: string;
    /** /liff opened with no order path — e.g. from the OA menu or a bare LIFF link. */
    openFromCard: string;
    loginError: (msg: string) => string;
    notFound: string;
    genericError: string;
    items: string;
    /** Items card when the order has no recognised items yet (owner is reviewing). */
    noItems: string;
    deliverTo: (addr: string) => string;
    trackLalamove: string;
    trackDelivery: string;
    recipientTitle: string;
    recipientRequiredHint: string;
    recipientNameLabel: string;
    recipientPhoneLabel: string;
    recipientPhoneInvalid: string;
    recipientConsent: string;
    recipientSave: string;
    recipientEdit: string;
    recipientCancel: string;
    recipientSummary: (name: string, phone: string) => string;
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
    productSubtotal: string;
    shippingFee: string;
    payInstructions: string;
    uploadSlip: string;
    uploading: string;
    uploadError: string;
    notSlipQr: string;
    expiredUploadHint: string;
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
    enableAria: string;
  };
  orderStatus: Record<OrderStatus, string>;
}
