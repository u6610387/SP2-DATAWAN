/**
 * Customer LIFF sync: Broadcast `{type:'order_updated', version}` on `order:{id}:{realtimeToken}`.
 * Payload never contains PII or prices; LIFF refetches via the API (ARCHITECTURE_AND_DB §1.3).
 * The owner dashboard uses postgres_changes directly and needs nothing from here.
 */
import type { OrderRow, OrderUpdatedBroadcast } from '@datawan/shared';

export interface Broadcaster {
  orderUpdated(order: Pick<OrderRow, 'id' | 'realtime_token' | 'version'>): Promise<void>;
}

export function orderChannel(order: Pick<OrderRow, 'id' | 'realtime_token'>): string {
  return `order:${order.id}:${order.realtime_token}`;
}

export function createSupabaseBroadcaster(supabaseUrl: string, serviceRoleKey: string, fetchImpl: typeof fetch = fetch): Broadcaster {
  return {
    async orderUpdated(order) {
      const payload: OrderUpdatedBroadcast = { type: 'order_updated', version: order.version };
      const res = await fetchImpl(`${supabaseUrl}/realtime/v1/api/broadcast`, {
        method: 'POST',
        headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ topic: orderChannel(order), event: 'order_updated', payload }] }),
      });
      // Best effort: LIFF also refetches on focus/reconnect.
      if (!res.ok) console.warn('realtime broadcast failed', res.status);
    },
  };
}

export class RecordingBroadcaster implements Broadcaster {
  sent: { channel: string; version: number }[] = [];
  async orderUpdated(order: Pick<OrderRow, 'id' | 'realtime_token' | 'version'>) {
    this.sent.push({ channel: orderChannel(order), version: order.version });
  }
}
