/** Zero-token info keywords: exact-match replies that never reach the AI parser or push. */
import { describe, expect, it } from 'vitest';
import { matchInfoCommand } from '../src/handlers/infoCommands';
import { CUSTOMER_LINE, makeHarness } from './harness';

const LIFF = 'https://liff.line.me/2000000000-abcdEFGH';

function setup() {
  const h = makeHarness();
  const parseCalls = { n: 0 };
  const orig = h.deps.ai.parseOrder.bind(h.deps.ai);
  h.deps.ai.parseOrder = (async (...a: Parameters<typeof orig>) => { parseCalls.n++; return orig(...a); }) as typeof orig;
  const lastText = () => {
    const m = h.line.lastReply()[0] as { type: string; text?: string } | undefined;
    return m?.type === 'text' ? m.text! : JSON.stringify(h.line.lastReply());
  };
  return { h, parseCalls, lastText };
}

describe('matchInfoCommand (exact match only)', () => {
  it.each([
    ['ดูรายการสินค้า', 'catalog'], ['  ดูรายการสินค้า  ', 'catalog'], ['ดูรายการสินค้าค่ะ', 'catalog'],
    ['เช็คสถานะจัดส่ง', 'delivery'], ['เช็กสถานะจัดส่ง', 'delivery'], ['ขอลิงก์ lalamove', 'delivery'], ['ขอลิ้งค์ Lalamove ครับ', 'delivery'],
    ['ขอลิงก์ออเดอร์', 'orderLink'], ['ขอลิงค์ออเดอร์', 'orderLink'],
    ['วิธีสั่งซื้อ', 'howTo'], ['ช่องทางชำระเงิน', 'payment'], ['ช่องทางชำระเงินคะ', 'payment'],
  ])('%s → %s', (t, kind) => expect(matchInfoCommand(t)).toBe(kind));

  it.each([
    'ดูรายการสินค้าหน่อย', 'อยากดูรายการสินค้าทั้งหมด', 'ปลาทับทิม 2 โล', 'วิธีสั่งซื้อกุ้ง 2 โล', 'เช็คสถานะจัดส่ง A12 ด้วย',
    'ขอลิงก์ออเดอร์ที่สั่งเมื่อวาน', 'ช่องทางชำระเงินมีอะไรบ้าง', 'ขอลิงก์หน่อย', '',
  ])('%s → null (normal flow)', (t) => expect(matchInfoCommand(t)).toBeNull());
});

describe('info keywords through the webhook', () => {
  it('ดูรายการสินค้า: active products grouped by category, uncategorised last, no AI call, reply only', async () => {
    const { h, parseCalls, lastText } = setup();
    h.repo.categories.push(
      { id: 'c-shell', name_th: 'หอย', sort: 2, is_active: true, created_at: '', updated_at: '' },
      { id: 'c-shrimp', name_th: 'กุ้ง', sort: 1, is_active: true, created_at: '', updated_at: '' },
    );
    h.repo.products.find((p) => p.id === 'p-kung')!.category_id = 'c-shrimp';
    h.repo.products.find((p) => p.id === 'p-hoi')!.category_id = 'c-shell';
    h.repo.seedProducts([{ id: 'p-off', name_th: 'ปลาเลิกขาย', aliases: [], unit: 'kg', prep_types: ['live'] }]);
    h.repo.products.find((p) => p.id === 'p-off')!.is_active = false;
    await h.customerText('ดูรายการสินค้า');
    const t = lastText();
    expect(t.indexOf('กุ้ง')).toBeLessThan(t.indexOf('หอย'));
    expect(t).toMatch(/กุ้ง\n• กุ้งแม่น้ำ \(กก\.\)/);
    expect(t).toMatch(/หอย\n• หอยแครง \(กก\.\)/);
    expect(t).toMatch(/อื่นๆ\n• ปูม้า \(กก\.\)/);
    expect(t).not.toContain('ปลาเลิกขาย');
    expect(t).toContain('ปลาทับทิม 2 โล');
    expect(parseCalls.n).toBe(0);
    expect(h.line.pushes).toHaveLength(0);
    expect(h.repo.orders).toHaveLength(0);
  });

  it('ดูรายการสินค้า with an empty catalog says so', async () => {
    const { h, lastText } = setup();
    for (const p of h.repo.products) p.is_active = false;
    await h.customerText('ดูรายการสินค้า');
    expect(lastText()).toContain('ยังไม่มีรายการสินค้า');
  });

  it('เช็คสถานะจัดส่ง: latest non-cancelled order with code, status, total and Lalamove link', async () => {
    const { h, parseCalls, lastText } = setup();
    await h.customerText('กุ้งแม่น้ำ 2 โล');
    const o = h.repo.orders[0]!;
    Object.assign(o, { status: 'DELIVERING', product_price_satang: 120000, shipping_fee_satang: 8000, total_satang: 128000, tracking_url: 'https://share.lalamove.com/?TH1&sign=x' });
    parseCalls.n = 0;
    await h.customerText('เช็คสถานะจัดส่ง');
    const t = lastText();
    expect(t).toContain(o.code);
    expect(t).toContain('กำลังจัดส่ง');
    expect(t).toContain('1,280');
    expect(t).toContain('https://share.lalamove.com/?TH1&sign=x');
    expect(parseCalls.n).toBe(0);
    expect(h.line.pushes).toHaveLength(0);
  });

  it('ขอลิงก์ lalamove before delivery is booked: clear note, price not yet quoted', async () => {
    const { h, lastText } = setup();
    await h.customerText('กุ้งแม่น้ำ 2 โล');
    Object.assign(h.repo.orders[0]!, { status: 'AWAITING_PRICE' });
    await h.customerText('ขอลิงก์ lalamove');
    const t = lastText();
    expect(t).toContain('ร้านกำลังเช็กของและราคา');
    expect(t).toContain('ยังไม่ได้เรียกรถส่ง');
    expect(t).toContain('ยังไม่ได้แจ้งราคา');
  });

  it('เช็คสถานะจัดส่ง skips cancelled orders and falls back to the last delivered one; none → no-order note', async () => {
    const { h, lastText } = setup();
    await h.customerText('เช็คสถานะจัดส่ง');
    expect(lastText()).toContain('ยังไม่มีออเดอร์');
    await h.customerText('กุ้งแม่น้ำ 2 โล');
    const o = h.repo.orders[0]!;
    Object.assign(o, { status: 'DELIVERED', delivered_at: '2027-01-14T03:00:00Z', total_satang: 50000, tracking_url: null });
    await h.customerText('หอยแครง 1 โล');
    Object.assign(h.repo.orders[1]!, { status: 'CANCELLED' });
    await h.customerText('เช็คสถานะจัดส่ง');
    expect(lastText()).toContain(o.code);
    expect(lastText()).toContain('จัดส่งสำเร็จแล้ว');
  });

  it('ขอลิงก์ออเดอร์: LIFF order-room URL of the active order; none → no-order note', async () => {
    const { h, parseCalls, lastText } = setup();
    await h.customerText('ขอลิงก์ออเดอร์');
    expect(lastText()).toContain('ยังไม่มีออเดอร์ค้าง');
    await h.customerText('กุ้งแม่น้ำ 2 โล');
    const o = h.repo.orders[0]!;
    parseCalls.n = 0;
    await h.customerText('ขอลิงก์ออเดอร์');
    expect(lastText()).toContain(`${LIFF}/orders/${o.id}`);
    expect(lastText()).toContain(o.code);
    expect(parseCalls.n).toBe(0);
    expect(h.line.pushes).toHaveLength(0);
    expect(h.repo.orders).toHaveLength(1);
  });

  it('วิธีสั่งซื้อ and ช่องทางชำระเงิน: fixed guides, no order touched', async () => {
    const { h, parseCalls, lastText } = setup();
    await h.customerText('วิธีสั่งซื้อ');
    expect(lastText()).toContain('ปลาทับทิม 2 โล');
    expect(lastText()).toContain('สลิป');
    await h.customerText('ช่องทางชำระเงิน');
    expect(lastText()).toMatch(/PromptPay|พร้อมเพย์/);
    expect(lastText()).toContain('สลิป');
    expect(lastText()).not.toContain('0812345678'); // account details only inside the order room
    expect(parseCalls.n).toBe(0);
    expect(h.repo.orders).toHaveLength(0);
  });

  it('a keyword during a draft does not edit the draft; a partial sentence still does', async () => {
    const { h, parseCalls } = setup();
    await h.customerText('กุ้งแม่น้ำ 2 โล');
    const before = JSON.stringify(h.repo.items);
    parseCalls.n = 0;
    await h.customerText('วิธีสั่งซื้อ');
    expect(parseCalls.n).toBe(0);
    expect(JSON.stringify(h.repo.items)).toBe(before);
    await h.customerText('ดูรายการสินค้าหน่อย');
    expect(parseCalls.n).toBe(1);
  });
});
