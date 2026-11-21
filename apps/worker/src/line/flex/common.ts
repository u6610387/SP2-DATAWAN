/** Small typed helpers for LINE Flex / quick replies (types from @line/bot-sdk). */
import type { messagingApi } from '@line/bot-sdk';
import { th, type OrderItemRow } from '@datawan/shared';

export type Msg = messagingApi.Message;
type FlexComponent = messagingApi.FlexComponent;
type Action = messagingApi.Action;

export const COLORS = { brand: '#0E7C86', muted: '#8C8C8C', green: '#1E9E5A', red: '#D93025' } as const;

export function liffUrl(liffId: string, path = ''): string {
  return liffId ? `https://liff.line.me/${liffId}${path}` : `https://line.me/R/`;
}
export function orderLiffUrl(liffId: string, orderId: string): string {
  return liffUrl(liffId, `/orders/${orderId}`);
}

export function postbackData(params: Record<string, string | number>): string {
  const s = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  if (s.length > 300) throw new Error('postback data exceeds 300 chars');
  return s;
}

export const text = (t: string, extra: Partial<messagingApi.FlexText> = {}): messagingApi.FlexText => ({ type: 'text', text: t, wrap: true, ...extra });
export const separator = (): messagingApi.FlexSeparator => ({ type: 'separator', margin: 'md' });
export const box = (layout: 'vertical' | 'horizontal' | 'baseline', contents: FlexComponent[], extra: Partial<messagingApi.FlexBox> = {}): messagingApi.FlexBox => ({
  type: 'box',
  layout,
  contents,
  ...extra,
});
export const postback = (label: string, data: string, displayText?: string): messagingApi.PostbackAction => ({
  type: 'postback',
  label,
  data,
  ...(displayText ? { displayText } : {}),
});
export const uri = (label: string, link: string): messagingApi.URIAction => ({ type: 'uri', label, uri: link });
export const button = (action: Action, style: 'primary' | 'secondary' | 'link' = 'primary'): messagingApi.FlexButton => ({
  type: 'button',
  action,
  style,
  height: 'sm',
  ...(style === 'primary' ? { color: COLORS.brand } : {}),
});

export function row(label: string, value: string, bold = false): messagingApi.FlexBox {
  return box('horizontal', [text(label, { size: 'sm', color: COLORS.muted, flex: 3 }), text(value, { size: 'sm', align: 'end', flex: 4, ...(bold ? { weight: 'bold' as const } : {}) })]);
}

export function itemLine(it: Pick<OrderItemRow, 'raw_text' | 'qty' | 'unit' | 'prep_type'> & { name?: string }): string {
  const prep = th.prep[it.prep_type] ? ` (${th.prep[it.prep_type]})` : '';
  return `• ${it.name ?? it.raw_text} ${it.qty} ${th.units[it.unit] ?? it.unit}${prep}`;
}

export function bubble(title: string, body: FlexComponent[], footer: FlexComponent[] = []): messagingApi.FlexBubble {
  return {
    type: 'bubble',
    size: 'kilo',
    header: box('vertical', [text(title, { weight: 'bold', color: '#FFFFFF', size: 'md' })], { backgroundColor: COLORS.brand, paddingAll: '12px' }),
    body: box('vertical', body, { spacing: 'sm' }),
    ...(footer.length ? { footer: box('vertical', footer, { spacing: 'sm' }) } : {}),
  };
}

export function flex(altText: string, contents: messagingApi.FlexBubble): messagingApi.FlexMessage {
  return { type: 'flex', altText, contents };
}

export function textMsg(t: string, quickReply?: messagingApi.QuickReply): messagingApi.TextMessage {
  return { type: 'text', text: t.slice(0, 5000), ...(quickReply ? { quickReply } : {}) };
}

export function quickReply(actions: Action[]): messagingApi.QuickReply {
  return { items: actions.slice(0, 13).map((action) => ({ type: 'action', action })) };
}
