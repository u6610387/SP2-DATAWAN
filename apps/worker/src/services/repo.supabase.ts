/**
 * Supabase implementation of Repo (service-role key; bypasses RLS — Worker only).
 * Relies on DB behaviour from supabase/migrations: version bump trigger, order code trigger (0002),
 * generated total_satang, unique indexes and status guards.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { FINAL_STATUSES, type OrderRow, type OrderStatus, type ProductRow } from '@datawan/shared';
import type { NewOrder, NewOrderItem, Repo } from './repo';

const OPEN_FILTER = `(${FINAL_STATUSES.map((s) => `"${s}"`).join(',')})`;

/** Untyped client (no generated Database types yet): rows are cast to the shared row types. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function must<T = any>(res: { data: unknown; error: { message: string; code?: string } | null }, op: string): T {
  if (res.error) throw new Error(`supabase ${op}: ${res.error.message}`);
  return res.data as T;
}

export class SupabaseRepo implements Repo {
  constructor(private readonly db: SupabaseClient) {}

  static fromEnv(url: string, serviceRoleKey: string): SupabaseRepo {
    return new SupabaseRepo(createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } }));
  }

  async markLineEvent(id: string) {
    const res = await this.db.from('line_events').upsert({ webhook_event_id: id }, { onConflict: 'webhook_event_id', ignoreDuplicates: true }).select('webhook_event_id');
    return must(res, 'markLineEvent').length > 0;
  }

  async upsertUserByLineId(lineUserId: string, displayName?: string | null) {
    const existing = must(await this.db.from('users').select('*').eq('line_user_id', lineUserId).maybeSingle(), 'getUser');
    if (existing) {
      if (!existing.is_active) must(await this.db.from('users').update({ is_active: true }).eq('id', existing.id), 'reactivate');
      return { ...existing, is_active: true };
    }
    return must(
      await this.db.from('users').upsert({ line_user_id: lineUserId, display_name: displayName ?? null }, { onConflict: 'line_user_id' }).select('*').single(),
      'insertUser',
    );
  }
  async getUser(id: string) {
    return must(await this.db.from('users').select('*').eq('id', id).maybeSingle(), 'getUser');
  }
  async setActiveOrder(userId: string, orderId: string | null) {
    must(await this.db.from('users').update({ active_order_id: orderId }).eq('id', userId), 'setActiveOrder');
  }
  async updateUserContact(userId: string, patch: { full_name: string; phone: string; pdpa_consent_at?: string }) {
    must(await this.db.from('users').update(patch).eq('id', userId), 'updateUserContact');
  }
  async markUserInactive(userId: string) {
    must(await this.db.from('users').update({ is_active: false }).eq('id', userId), 'markUserInactive');
  }

  async listActiveCategories() {
    return must(await this.db.from('categories').select('*').eq('is_active', true).order('sort').order('name_th'), 'listCategories');
  }
  async getCategory(id: string) {
    return must(await this.db.from('categories').select('*').eq('id', id).maybeSingle(), 'getCategory');
  }
  async insertCategory(c: { name_th: string; sort?: number }) {
    return must(await this.db.from('categories').insert(c).select('*').single(), 'insertCategory');
  }
  async getProduct(id: string) {
    return must(await this.db.from('products').select('*').eq('id', id).maybeSingle(), 'getProduct');
  }
  async updateProduct(id: string, patch: Partial<Pick<ProductRow, 'name_th' | 'aliases' | 'unit' | 'prep_types' | 'category_id' | 'is_active'>>) {
    return must(await this.db.from('products').update(patch).eq('id', id).select('*').single(), 'updateProduct');
  }
  async insertProduct(p: { name_th: string; aliases: string[]; unit: ProductRow['unit']; prep_types: ProductRow['prep_types']; category_id: string | null }) {
    return must(await this.db.from('products').insert(p).select('*').single(), 'insertProduct');
  }
  async listActiveProducts() {
    return must(await this.db.from('products').select('*').eq('is_active', true).order('name_th'), 'listProducts');
  }

  async createOrder(order: NewOrder, items: NewOrderItem[]) {
    // `code` is assigned by the assign_order_code trigger (0002_order_code.sql).
    const row = must(await this.db.from('orders').insert(order).select('*').single(), 'createOrder') as OrderRow;
    if (items.length) await this.replaceItems(row.id, items);
    return row;
  }
  async getOrder(id: string) {
    return must(await this.db.from('orders').select('*').eq('id', id).maybeSingle(), 'getOrder');
  }
  async getOpenOrderByCode(code: string) {
    return must(
      await this.db.from('orders').select('*').ilike('code', code).not('status', 'in', OPEN_FILTER).maybeSingle(),
      'getOpenOrderByCode',
    );
  }
  async listOpenOrders(filter: { userId?: string; statuses?: OrderStatus[] } = {}) {
    let q = this.db.from('orders').select('*').not('status', 'in', OPEN_FILTER).order('created_at', { ascending: false });
    if (filter.userId) q = q.eq('user_id', filter.userId);
    if (filter.statuses) q = q.in('status', filter.statuses);
    return must(await q, 'listOpenOrders');
  }
  async lastDeliveredOrder(userId: string) {
    return must(
      await this.db.from('orders').select('*').eq('user_id', userId).eq('status', 'DELIVERED').order('delivered_at', { ascending: false }).limit(1).maybeSingle(),
      'lastDeliveredOrder',
    );
  }
  async listDeliveredSince(sinceIso: string) {
    return must(await this.db.from('orders').select('*').eq('status', 'DELIVERED').gte('delivered_at', sinceIso), 'listDeliveredSince');
  }
  async updateOrder(id: string, expectedVersion: number, patch: import('@datawan/shared').OrderPatch) {
    const res = await this.db.from('orders').update(patch).eq('id', id).eq('version', expectedVersion).select('*');
    const rows = must(res, 'updateOrder') as OrderRow[];
    return rows[0] ?? null;
  }

  async getItems(orderId: string) {
    return must(await this.db.from('order_items').select('*').eq('order_id', orderId).order('sort'), 'getItems');
  }
  async replaceItems(orderId: string, items: NewOrderItem[]) {
    must(await this.db.from('order_items').delete().eq('order_id', orderId), 'deleteItems');
    if (!items.length) return [];
    return must(
      await this.db.from('order_items').insert(items.map((it, sort) => ({ ...it, order_id: orderId, sort }))).select('*'),
      'insertItems',
    );
  }
  async updateItemCosts(updates: { id: string; cost_satang: number | null }[]) {
    for (const u of updates) must(await this.db.from('order_items').update({ cost_satang: u.cost_satang }).eq('id', u.id), 'updateItemCost');
  }
  async updateItemActualQty(updates: { id: string; actual_qty: number }[]) {
    for (const u of updates) must(await this.db.from('order_items').update({ actual_qty: u.actual_qty }).eq('id', u.id), 'updateItemActualQty');
  }
  async touchCustomerLastSeen(orderId: string, nowIso: string) {
    must(await this.db.from('orders').update({ customer_last_seen_at: nowIso }).eq('id', orderId), 'touchCustomerLastSeen');
  }

  async insertAddress(a: import('./repo').NewAddress) {
    return must(await this.db.from('addresses').insert(a).select('*').single(), 'insertAddress');
  }
  async setAddressRecipient(id: string, patch: { recipient_name: string; recipient_phone: string }) {
    must(await this.db.from('addresses').update(patch).eq('id', id), 'setAddressRecipient');
  }
  async getAddress(id: string) {
    return must(await this.db.from('addresses').select('*').eq('id', id).maybeSingle(), 'getAddress');
  }

  async listNegotiations(orderId: string) {
    return must(await this.db.from('negotiations').select('*').eq('order_id', orderId).order('round'), 'listNegotiations');
  }
  async insertNegotiation(n: import('./repo').NewNegotiation) {
    return must(await this.db.from('negotiations').insert(n).select('*').single(), 'insertNegotiation');
  }

  async insertPayment(p: import('./repo').NewPayment) {
    return must(await this.db.from('payments').insert(p).select('*').single(), 'insertPayment');
  }
  async getPayment(id: string) {
    return must(await this.db.from('payments').select('*').eq('id', id).maybeSingle(), 'getPayment');
  }
  async latestPayment(orderId: string) {
    return must(
      await this.db.from('payments').select('*').eq('order_id', orderId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      'latestPayment',
    );
  }
  async updatePayment(id: string, patch: import('./repo').PaymentPatch) {
    return must(await this.db.from('payments').update(patch).eq('id', id).select('*').single(), 'updatePayment');
  }
  async referenceExists(ref: string) {
    const res = await this.db.from('payments').select('id', { count: 'exact', head: true }).eq('reference_no', ref);
    if (res.error) throw new Error(`supabase referenceExists: ${res.error.message}`);
    return (res.count ?? 0) > 0;
  }
  async findPaymentByReference(ref: string) {
    return must(await this.db.from('payments').select('*').eq('reference_no', ref).maybeSingle(), 'findPaymentByReference');
  }

  async latestUnitCost(productId: string, sinceIso?: string) {
    let q = this.db.from('price_history').select('unit_price_satang').eq('product_id', productId).eq('kind', 'cost');
    if (sinceIso) q = q.gte('recorded_at', sinceIso);
    const row = must(await q.order('recorded_at', { ascending: false }).limit(1).maybeSingle(), 'latestUnitCost');
    return row?.unit_price_satang ?? null;
  }
  async lastSellUnitPrice(userId: string, productId: string, sinceIso: string) {
    const row = must(
      await this.db
        .from('price_history')
        .select('unit_price_satang')
        .eq('user_id', userId)
        .eq('product_id', productId)
        .eq('kind', 'sell')
        .gte('recorded_at', sinceIso)
        .order('recorded_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      'lastSellUnitPrice',
    );
    return row?.unit_price_satang ?? null;
  }

  async insertStockLogs(rows: import('./repo').NewStockLog[]) {
    if (rows.length) must(await this.db.from('stock_logs').insert(rows), 'insertStockLogs');
  }
  async insertStockLog(row: import('./repo').NewStockLog) {
    return must(await this.db.from('stock_logs').insert(row).select('*').single(), 'insertStockLog');
  }
  async insertPriceHistory(rows: import('./repo').NewPriceHistory[]) {
    if (rows.length) must(await this.db.from('price_history').insert(rows), 'insertPriceHistory');
  }
  async listProductStock() {
    return must(await this.db.from('product_stock').select('*').order('name_th'), 'listProductStock');
  }

  async upsertPushSubscription(sub: import('./repo').NewPushSubscription) {
    return must(await this.db.from('push_subscriptions').upsert(sub, { onConflict: 'endpoint' }).select('*').single(), 'upsertPushSubscription');
  }
  async listPushSubscriptions() {
    return must(await this.db.from('push_subscriptions').select('*'), 'listPushSubscriptions');
  }
  async deletePushSubscription(endpoint: string) {
    must(await this.db.from('push_subscriptions').delete().eq('endpoint', endpoint), 'deletePushSubscription');
  }

  async latestQuotaLog(month: string) {
    return must(
      await this.db.from('quota_logs').select('*').eq('month', month).order('checked_at', { ascending: false }).limit(1).maybeSingle(),
      'latestQuotaLog',
    );
  }
  async insertQuotaLog(row: import('./repo').NewQuotaLog) {
    return must(await this.db.from('quota_logs').insert(row).select('*').single(), 'insertQuotaLog');
  }

  async insertEvent(e: import('./repo').NewOrderEvent) {
    return must(await this.db.from('order_events').insert(e).select('*').single(), 'insertEvent');
  }
  async listPushEvents(orderId: string) {
    return must(
      await this.db.from('order_events').select('*').eq('order_id', orderId).in('event', ['PUSH_SENT', 'PUSH_DEFERRED']).order('created_at', { ascending: false }).limit(20),
      'listPushEvents',
    );
  }
  async getEvent(id: string) {
    return must(await this.db.from('order_events').select('*').eq('id', id).maybeSingle(), 'getEvent');
  }
  async countEventsSince(event: string, sinceIso: string) {
    const res = await this.db.from('order_events').select('id', { count: 'exact', head: true }).eq('event', event).gte('created_at', sinceIso);
    if (res.error) throw new Error(`supabase countEventsSince: ${res.error.message}`);
    return res.count ?? 0;
  }
}
