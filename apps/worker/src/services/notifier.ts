/**
 * Owner notifications — PWA Web Push + dashboard Realtime, NEVER LINE push (CLAUDE.md §3.4).
 * TODO(Kitirat): implement WebPushNotifier (VAPID, push_subscriptions table) in Part 2.
 */
export type OwnerAlert =
  | { kind: 'NEW_ORDER'; orderId: string; code: string; summary: string; suggestedPriceSatang: number | null }
  | { kind: 'COUNTER_OFFER'; orderId: string; code: string; amountSatang: number; marginColor: 'GREEN' | 'RED' | 'GREY' }
  | { kind: 'ACCEPTED'; orderId: string; code: string }
  | { kind: 'SLIP_UPLOADED'; orderId: string; code: string; result: string }
  | { kind: 'OWNER_TIMEOUT'; orderId: string; code: string; minutes: number }
  | { kind: 'PAYMENT_EXPIRED'; orderId: string; code: string }
  | { kind: 'QUOTA_WARNING'; used: number; limit: number; mode: string }
  | { kind: 'NEEDS_REVIEW'; orderId: string; code: string; reason: string }
  // B2B alerts carry no business name: the push is shown on a lock screen (PDPA).
  | { kind: 'B2B_APPLICATION'; userId: string }
  | { kind: 'B2B_REREVIEW'; userId: string };

export interface OwnerNotifier {
  notify(alert: OwnerAlert): Promise<void>;
}

export class ConsoleNotifier implements OwnerNotifier {
  async notify(alert: OwnerAlert) {
    console.log('[owner-alert]', JSON.stringify(alert));
  }
}

export class RecordingNotifier implements OwnerNotifier {
  alerts: OwnerAlert[] = [];
  async notify(alert: OwnerAlert) {
    this.alerts.push(alert);
  }
}
