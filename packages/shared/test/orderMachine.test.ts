import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES, type OrderStatus } from '../src/db';
import { OWNER_ONLY_TARGETS, TRANSITIONS, transition, type OrderEvent } from '../src/state/orderMachine';

const events = Object.keys(TRANSITIONS) as OrderEvent[];

describe('order state machine — human-in-the-loop safety (CLAUDE.md §3.1)', () => {
  it('no system/ai event targets PAID, DELIVERING or DELIVERED', () => {
    for (const e of events) {
      const spec = TRANSITIONS[e];
      if (spec.actor === 'owner') continue;
      for (const to of Object.values(spec.edges)) {
        expect(OWNER_ONLY_TARGETS, `${e} (${spec.actor}) → ${to}`).not.toContain(to);
      }
    }
  });

  it('no ai-actor events exist at all', () => {
    expect(events.filter((e) => TRANSITIONS[e].actor === 'ai')).toEqual([]);
  });

  it('every OWNER_* event is owner-only', () => {
    for (const e of events.filter((x) => x.startsWith('OWNER_'))) expect(TRANSITIONS[e].actor).toBe('owner');
  });

  it('rejects any actor other than the declared one, for every edge', () => {
    for (const e of events) {
      for (const from of Object.keys(TRANSITIONS[e].edges) as OrderStatus[]) {
        for (const actor of ['owner', 'customer', 'system', 'ai'] as const) {
          const r = transition(from, e, actor);
          expect(r.ok).toBe(actor === TRANSITIONS[e].actor);
        }
      }
    }
  });

  it('no transition leaves a final state', () => {
    for (const e of events) {
      expect(TRANSITIONS[e].edges.DELIVERED).toBeUndefined();
      expect(TRANSITIONS[e].edges.CANCELLED).toBeUndefined();
    }
  });

  it('happy path is reachable 1→9', () => {
    const path: [OrderEvent, 'owner' | 'customer'][] = [
      ['CUSTOMER_CONFIRM', 'customer'],
      ['LOCATION_SET', 'customer'],
      ['OWNER_SET_PRICE', 'owner'],
      ['CUSTOMER_COUNTER', 'customer'],
      ['OWNER_ACCEPT', 'owner'],
      ['OWNER_SET_SHIPPING', 'owner'],
      ['SLIP_UPLOADED', 'customer'],
      ['OWNER_CONFIRM_PAYMENT', 'owner'],
      ['OWNER_DISPATCH', 'owner'],
      ['OWNER_DELIVERED', 'owner'],
    ];
    let s: OrderStatus = 'AWAITING_CONFIRMATION';
    for (const [e, a] of path) {
      const r = transition(s, e, a);
      expect(r.ok, `${s} --${e}-->`).toBe(true);
      if (r.ok) s = r.to;
    }
    expect(s).toBe('DELIVERED');
  });

  it('owner offline never auto-cancels AWAITING_PRICE', () => {
    expect(transition('AWAITING_PRICE', 'ABANDON_TIMEOUT', 'system').ok).toBe(false);
  });

  it('covers every status somewhere', () => {
    const seen = new Set<OrderStatus>(['AWAITING_CONFIRMATION']);
    for (const e of events) for (const [f, t] of Object.entries(TRANSITIONS[e].edges)) { seen.add(f as OrderStatus); seen.add(t as OrderStatus); }
    expect([...seen].sort()).toEqual([...ORDER_STATUSES].sort());
  });
});

describe('slip uploads (production A10)', () => {
  it('only while payment is due or just expired; never during review or after', async () => {
    const { canFire } = await import('../src/state/orderMachine');
    expect(canFire('AWAITING_PAYMENT', 'SLIP_UPLOADED')).toBe(true);
    expect(canFire('PAYMENT_EXPIRED', 'SLIP_UPLOADED')).toBe(true);
    for (const s of ['PAYMENT_REVIEW', 'PAID', 'DELIVERING', 'DELIVERED', 'CANCELLED', 'PRICE_QUOTED', 'AWAITING_SHIPPING_FEE'] as const) {
      expect(canFire(s, 'SLIP_UPLOADED'), s).toBe(false);
    }
  });
});
