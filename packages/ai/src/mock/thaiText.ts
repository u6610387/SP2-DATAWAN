/** Small deterministic Thai-text helpers shared by the mock providers (and usable as an eval baseline). */
import type { CatalogRef, PrepType, Unit } from '@datawan/shared';
import { thaiDigitsToArabic } from '../pii/strip';

export const NUMBER_WORDS: Record<string, number> = {
  ครึ่ง: 0.5,
  หนึ่ง: 1,
  นึง: 1,
  เดียว: 1,
  สอง: 2,
  สาม: 3,
  สี่: 4,
  ห้า: 5,
  หก: 6,
  เจ็ด: 7,
  แปด: 8,
  เก้า: 9,
  สิบ: 10,
};
const NUM_WORD = Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length).join('|');

const UNIT_WORDS: [RegExp, Unit, number][] = [
  [/^(กิโลกรัม|กิโล|โล|กก\.?|kg)/i, 'kg', 1],
  [/^ขีด/, 'kg', 0.1],
  [/^ตัว/, 'piece', 1],
  [/^กล่อง/, 'box', 1],
  [/^ถาด/, 'tray', 1],
  [/^ชุด/, 'set', 1],
];
const UNIT_ALT = 'กิโลกรัม|กิโล|โล|กก\\.?|kg|ขีด|ตัว|กล่อง|ถาด|ชุด';

function unitOf(word: string): { unit: Unit; factor: number } | null {
  for (const [re, unit, factor] of UNIT_WORDS) if (re.test(word)) return { unit, factor };
  return null;
}

export interface QtyMatch {
  qty: number;
  unit: Unit;
  start: number;
  end: number;
}

/** Find the first quantity+unit in `seg` (offset = seg's index in the full text). */
export function findQuantity(seg: string, offset: number): QtyMatch | null {
  const s = thaiDigitsToArabic(seg);
  const candidates: QtyMatch[] = [];
  const push = (m: RegExpExecArray | null, qty: number, unitWord: string) => {
    if (!m) return;
    const u = unitOf(unitWord);
    if (!u || !(qty > 0)) return;
    candidates.push({ qty: round3(qty * u.factor), unit: u.unit, start: offset + m.index, end: offset + m.index + m[0].length });
  };
  // "2 โล", "2.5กก", "1 โลครึ่ง"
  let m = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT_ALT})(ครึ่ง)?`, 'i').exec(s);
  if (m) push(m, Number(m[1]) + (m[3] ? 0.5 : 0), m[2]!);
  // "สามโล", "ครึ่งโล"
  m = new RegExp(`(${NUM_WORD})\\s*(${UNIT_ALT})(ครึ่ง)?`).exec(s);
  if (m) push(m, NUMBER_WORDS[m[1]!]! + (m[3] ? 0.5 : 0), m[2]!);
  // "โลนึง", "โลครึ่ง", "ตัวเดียว"
  m = new RegExp(`(${UNIT_ALT})\\s*(นึง|หนึ่ง|เดียว|ครึ่ง)`).exec(s);
  if (m) push(m, m[2] === 'ครึ่ง' ? 1.5 : 1, m[1]!);
  candidates.sort((a, b) => a.start - b.start);
  return candidates[0] ?? null;
}

export function detectPrep(seg: string): PrepType {
  if (/แช่แข็ง/.test(seg)) return 'frozen';
  if (/แช่เย็น|น้ำแข็ง/.test(seg)) return 'chilled';
  if (/ต้ม|นึ่ง|สุก|ลวก/.test(seg)) return 'cooked';
  if (/เป็นๆ|เป็น ๆ|ยังเป็น|สดเป็น|ตัวเป็น/.test(seg)) return 'live';
  return 'any';
}

export function detectNote(seg: string): string | null {
  const m = /(ไซส์|ไซซ์|size)\s*\d+|ตัวใหญ่ๆ?|ตัวเล็กๆ?|ไม่เอาหัว|แกะเปลือก|ล้างให้ด้วย/i.exec(thaiDigitsToArabic(seg));
  return m ? m[0] : null;
}

export interface AliasHit {
  ref: CatalogRef;
  alias: string;
  start: number;
  end: number;
}

/** Longest-first, non-overlapping alias matches, in text order. */
export function findProducts(text: string, catalog: CatalogRef[]): AliasHit[] {
  const all = catalog
    .flatMap((ref) => ref.aliases.map((alias) => ({ ref, alias })))
    .filter((x) => x.alias.length >= 2)
    .sort((a, b) => b.alias.length - a.alias.length);
  const taken: boolean[] = new Array(text.length).fill(false);
  const hits: AliasHit[] = [];
  for (const { ref, alias } of all) {
    let from = 0;
    for (;;) {
      const i = text.indexOf(alias, from);
      if (i < 0) break;
      from = i + 1;
      const end = i + alias.length;
      if (taken.slice(i, end).some(Boolean)) continue;
      for (let k = i; k < end; k++) taken[k] = true;
      hits.push({ ref, alias, start: i, end });
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

export function extractNumbers(text: string): number[] {
  return [...thaiDigitsToArabic(text).replace(/(\d),(\d{3})/g, '$1$2').matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ---------- delivery time ----------

/** Bangkok calendar date (YYYY-MM-DD) and hour for an ISO timestamp with any offset. */
function bangkokParts(iso: string): { date: string; hour: number; minute: number } {
  const t = new Date(Date.parse(iso) + 7 * 3600_000);
  return { date: t.toISOString().slice(0, 10), hour: t.getUTCHours(), minute: t.getUTCMinutes() };
}
function addDays(date: string, days: number): string {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}
const pad = (n: number) => n.toString().padStart(2, '0');

export function parseDeliveryTime(text: string, nowBangkok: string): { iso: string | null; raw_text: string | null } {
  const s = thaiDigitsToArabic(text);
  const spans: [number, number][] = [];
  let dayOffset: number | null = null;
  const day = /(วันนี้|พรุ่งนี้|มะรืน(?:นี้)?)/.exec(s);
  if (day) {
    dayOffset = day[1] === 'วันนี้' ? 0 : day[1] === 'พรุ่งนี้' ? 1 : 2;
    spans.push([day.index, day.index + day[0].length]);
  }
  let hour: number | null = null;
  let minute = 0;
  const tries: [RegExp, (m: RegExpExecArray) => number][] = [
    [/(\d{1,2})[:.](\d{2})\s*(?:น\.)?/, (m) => ((minute = Number(m[2])), Number(m[1]))],
    [/บ่าย\s*(\d{1,2})?\s*โมง/, (m) => 12 + Number(m[1] ?? 1)],
    [/(\d{1,2})\s*ทุ่ม/, (m) => 18 + Number(m[1])],
    [/(\d{1,2})\s*โมง\s*(เช้า|เย็น)?/, (m) => {
      const n = Number(m[1]);
      if (m[2] === 'เย็น') return n < 12 ? n + 12 : n;
      if (m[2] === 'เช้า') return n;
      return n >= 1 && n <= 5 ? n + 12 : n; // "2 โมง" ≈ 14:00, "6 โมง" ≈ 06:00
    }],
    [/เช้า/, () => 7],
    [/สาย/, () => 10],
    [/บ่าย/, () => 14],
    [/เย็น/, () => 17],
  ];
  for (const [re, fn] of tries) {
    const m = re.exec(s);
    if (m) {
      hour = fn(m);
      spans.push([m.index, m.index + m[0].length]);
      break;
    }
  }
  if (dayOffset === null && hour === null) return { iso: null, raw_text: null };
  const now = bangkokParts(nowBangkok);
  if (hour === null) hour = 9;
  if (dayOffset === null) dayOffset = hour * 60 + minute > now.hour * 60 + now.minute ? 0 : 1;
  if (hour > 23) hour = 23;
  const iso = `${addDays(now.date, dayOffset)}T${pad(hour)}:${pad(minute)}:00+07:00`;
  const start = Math.min(...spans.map((x) => x[0]));
  const end = Math.max(...spans.map((x) => x[1]));
  const raw = end - start <= 25 ? text.slice(start, end) : text.slice(spans[0]![0], spans[0]![1]);
  return { iso, raw_text: raw.trim() };
}

/** FNV-1a 32-bit — deterministic fingerprint for mock fixtures. */
export function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
