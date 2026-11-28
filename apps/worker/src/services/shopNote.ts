/**
 * Owner notes (AI-polished, owner-approved: NOTE_APPROVED) reach the customer without a LINE push
 * (push slots are only for LIFECYCLE_PUSHES, line/quota.ts):
 *  - LIFF order room: the latest note is part of CustomerOrderView (shopNote);
 *  - chat: shown once, at the top of the next free reply to the customer (NOTE_SHOWN_IN_CHAT).
 */
import type { OrderEventRow, OrderRow } from '@datawan/shared';
import type { Deps } from '../deps';
import type { LineMessage } from '../line/api';
import * as flex from '../line/flex';
import { logEvent } from './orders';

export interface ShopNote {
  eventId: string;
  text: string;
  at: string;
}

/** Latest approved note of an order (events in any order). */
export function latestShopNote(events: OrderEventRow[]): ShopNote | null {
  const notes = events
    .filter((e) => e.event === 'NOTE_APPROVED' && typeof (e.payload as { message_th?: unknown } | null)?.message_th === 'string')
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const last = notes.at(-1);
  return last ? { eventId: last.id, text: (last.payload as { message_th: string }).message_th, at: last.created_at } : null;
}

function shownInChat(events: OrderEventRow[], noteEventId: string): boolean {
  return events.some((e) => e.event === 'NOTE_SHOWN_IN_CHAT' && (e.payload as { noteEventId?: string } | null)?.noteEventId === noteEventId);
}

/**
 * Notes of these orders not yet shown in chat, as text messages (oldest order first), and marks
 * them shown. Call only when a reply is actually going out.
 */
export async function takeChatNotes(deps: Deps, orders: OrderRow[], max: number): Promise<LineMessage[]> {
  const out: LineMessage[] = [];
  for (const order of orders) {
    if (out.length >= max) break;
    const events = await deps.repo.listOrderEvents(order.id);
    const note = latestShopNote(events);
    if (!note || shownInChat(events, note.eventId)) continue;
    await logEvent(deps, order, 'system', 'NOTE_SHOWN_IN_CHAT', { noteEventId: note.eventId });
    out.push(flex.textMsg(`💬 ข้อความจากร้าน (ออเดอร์ ${order.code})\n${note.text}`));
  }
  return out;
}

/** LINE allows 5 messages per reply; the reply's own messages always win the space. */
const REPLY_MAX = 5;

/**
 * `deps` whose line.reply puts this customer's unseen shop notes first (free reply, no push).
 * Every customer-facing reply in the chat handler goes through here, so no path forgets them.
 */
export function withChatNotes(deps: Deps, userId: string): Deps {
  const line = Object.create(deps.line) as Deps['line'];
  line.reply = async (token, messages) => {
    const room = REPLY_MAX - messages.length;
    const open = room > 0 ? await deps.repo.listOpenOrders({ userId }) : [];
    const notes = open.length ? await takeChatNotes(deps, [...open].reverse(), room) : [];
    return deps.line.reply(token, [...notes, ...messages]);
  };
  return { ...deps, line };
}
