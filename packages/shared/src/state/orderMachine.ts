/**
 * Order state machine — docs/ARCHITECTURE_AND_DB.md §4.
 * The ONLY place that decides which status follows which. Worker and dashboard both use it.
 *
 * Safety rule (CLAUDE.md §3.1): no event whose actor is 'system' or 'ai' may target
 * PAID, DELIVERING or DELIVERED. test/orderMachine.test.ts enforces this.
 */
import type { EventActor, OrderStatus } from '../db';

export type OrderEvent =
  | 'CUSTOMER_EDIT'
  | 'CUSTOMER_CONFIRM'
  | 'LOCATION_SET'
  | 'OWNER_SET_PRICE'
  | 'CUSTOMER_ACCEPT'
  | 'CUSTOMER_COUNTER'
  | 'OWNER_ACCEPT'
  | 'OWNER_COUNTER'
  | 'OWNER_HOLD'
  | 'OWNER_SET_SHIPPING'
  | 'SLIP_UPLOADED'
  | 'PAYMENT_TIMEOUT'
  | 'OWNER_CONFIRM_PAYMENT'
  | 'OWNER_REJECT_SLIP'
  | 'OWNER_DISPATCH'
  | 'OWNER_DELIVERED'
  | 'CUSTOMER_CANCEL'
  | 'OWNER_CANCEL'
  | 'ABANDON_TIMEOUT';

interface EventSpec {
  actor: EventActor;
  /** from → to */
  edges: Partial<Record<OrderStatus, OrderStatus>>;
}

const PRE_PAYMENT_CANCELLABLE: OrderStatus[] = [
  'AWAITING_CONFIRMATION',
  'AWAITING_LOCATION',
  'AWAITING_PRICE',
  'PRICE_QUOTED',
  'NEGOTIATING',
  'AWAITING_SHIPPING_FEE',
  'AWAITING_PAYMENT',
];

function toCancelled(froms: OrderStatus[]): Partial<Record<OrderStatus, OrderStatus>> {
  return Object.fromEntries(froms.map((f) => [f, 'CANCELLED'])) as Partial<Record<OrderStatus, OrderStatus>>;
}

export const TRANSITIONS: Readonly<Record<OrderEvent, EventSpec>> = {
  CUSTOMER_EDIT: {
    actor: 'customer',
    edges: {
      AWAITING_CONFIRMATION: 'AWAITING_CONFIRMATION',
      AWAITING_LOCATION: 'AWAITING_CONFIRMATION',
      AWAITING_PRICE: 'AWAITING_PRICE',
      PRICE_QUOTED: 'AWAITING_PRICE',
      NEGOTIATING: 'AWAITING_PRICE',
    },
  },
  CUSTOMER_CONFIRM: { actor: 'customer', edges: { AWAITING_CONFIRMATION: 'AWAITING_LOCATION' } },
  LOCATION_SET: { actor: 'customer', edges: { AWAITING_LOCATION: 'AWAITING_PRICE' } },
  OWNER_SET_PRICE: { actor: 'owner', edges: { AWAITING_PRICE: 'PRICE_QUOTED', PRICE_QUOTED: 'PRICE_QUOTED' } },
  CUSTOMER_ACCEPT: { actor: 'customer', edges: { PRICE_QUOTED: 'AWAITING_SHIPPING_FEE' } },
  CUSTOMER_COUNTER: { actor: 'customer', edges: { PRICE_QUOTED: 'NEGOTIATING' } },
  OWNER_ACCEPT: { actor: 'owner', edges: { NEGOTIATING: 'AWAITING_SHIPPING_FEE' } },
  OWNER_COUNTER: { actor: 'owner', edges: { NEGOTIATING: 'PRICE_QUOTED' } },
  OWNER_HOLD: { actor: 'owner', edges: { NEGOTIATING: 'PRICE_QUOTED' } },
  OWNER_SET_SHIPPING: {
    actor: 'owner',
    edges: {
      AWAITING_SHIPPING_FEE: 'AWAITING_PAYMENT',
      AWAITING_PAYMENT: 'AWAITING_PAYMENT', // owner corrects the fee → new QR + timer
      PAYMENT_EXPIRED: 'AWAITING_PAYMENT',
    },
  },
  SLIP_UPLOADED: {
    actor: 'customer',
    edges: { AWAITING_PAYMENT: 'PAYMENT_REVIEW', PAYMENT_EXPIRED: 'PAYMENT_REVIEW', PAYMENT_REVIEW: 'PAYMENT_REVIEW' },
  },
  PAYMENT_TIMEOUT: { actor: 'system', edges: { AWAITING_PAYMENT: 'PAYMENT_EXPIRED' } },
  OWNER_CONFIRM_PAYMENT: { actor: 'owner', edges: { PAYMENT_REVIEW: 'PAID' } },
  OWNER_REJECT_SLIP: { actor: 'owner', edges: { PAYMENT_REVIEW: 'AWAITING_PAYMENT' } },
  OWNER_DISPATCH: { actor: 'owner', edges: { PAID: 'DELIVERING' } },
  OWNER_DELIVERED: { actor: 'owner', edges: { DELIVERING: 'DELIVERED' } },
  CUSTOMER_CANCEL: { actor: 'customer', edges: toCancelled(PRE_PAYMENT_CANCELLABLE) },
  OWNER_CANCEL: { actor: 'owner', edges: toCancelled([...PRE_PAYMENT_CANCELLABLE, 'PAYMENT_EXPIRED', 'PAYMENT_REVIEW']) },
  // Owner offline must never auto-cancel AWAITING_PRICE (PROJECT_SPEC §6.4).
  ABANDON_TIMEOUT: {
    actor: 'system',
    edges: toCancelled(['AWAITING_CONFIRMATION', 'AWAITING_LOCATION', 'PRICE_QUOTED', 'PAYMENT_EXPIRED']),
  },
};

/** Statuses only an owner action may enter. */
export const OWNER_ONLY_TARGETS: readonly OrderStatus[] = ['PAID', 'DELIVERING', 'DELIVERED'];

export type TransitionResult =
  | { ok: true; from: OrderStatus; to: OrderStatus; event: OrderEvent; actor: EventActor }
  | { ok: false; reason: 'WRONG_ACTOR' | 'INVALID_FROM_STATE'; from: OrderStatus; event: OrderEvent; actor: EventActor };

export function transition(from: OrderStatus, event: OrderEvent, actor: EventActor): TransitionResult {
  const spec = TRANSITIONS[event];
  if (spec.actor !== actor) return { ok: false, reason: 'WRONG_ACTOR', from, event, actor };
  const to = spec.edges[from];
  if (!to) return { ok: false, reason: 'INVALID_FROM_STATE', from, event, actor };
  // Belt and braces: the table is also checked by tests, but never let a non-owner reach these.
  if (OWNER_ONLY_TARGETS.includes(to) && actor !== 'owner') {
    return { ok: false, reason: 'WRONG_ACTOR', from, event, actor };
  }
  return { ok: true, from, to, event, actor };
}

export function canFire(from: OrderStatus, event: OrderEvent): boolean {
  return TRANSITIONS[event].edges[from] !== undefined;
}

/** Events available from a status (dashboard uses this to decide which buttons to show). */
export function availableEvents(from: OrderStatus, actor?: EventActor): OrderEvent[] {
  return (Object.keys(TRANSITIONS) as OrderEvent[]).filter(
    (e) => canFire(from, e) && (actor === undefined || TRANSITIONS[e].actor === actor),
  );
}

export function isFinal(status: OrderStatus): boolean {
  return status === 'DELIVERED' || status === 'CANCELLED';
}
