/**
 * PII strip / restore — docs/API_AND_AI_CONTRACTS.md §5.1.
 * Every Gemini payload passes through stripPII() and assertNoPII() (CLAUDE.md §3.3).
 * The token map lives in memory only; never log it.
 */

export type PiiKind = 'PHONE' | 'EMAIL' | 'URL' | 'NAME' | 'ADDR' | 'ACCT';
export type PiiMap = Record<string, string>;

export interface PiiContext {
  /** This customer's full_name, display_name, business_name, saved recipient names. */
  knownNames: string[];
  /** Product names/aliases — never masked as names or addresses. */
  productAliases: string[];
}

export class PiiLeakError extends Error {
  constructor(public readonly kinds: PiiKind[]) {
    super(`PII detected in AI payload: ${kinds.join(', ')}`);
    this.name = 'PiiLeakError';
  }
}

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';
export function thaiDigitsToArabic(s: string): string {
  return s.replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)));
}

export const PHONE_RE = /(?:\+66|0)[\s-]?[2-9](?:[\s-]?\d){7,8}/g;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const URL_RE = /https?:\/\/[^\s]+/g;
const ACCT_DASHED_RE = /\b\d{3}-\d-\d{5}-\d\b/g;
const ACCT_RUN_RE = /\b\d{10,12}\b/g;
const POSTCODE_RE = /\b[1-9]\d{4}\b/g;
const HONORIFIC_RE = /(คุณ|พี่|น้อง|ป้า|ลุง|เจ๊|เฮีย)\s?([ก-๙A-Za-z]{2,15})/g;
const ADDRESS_MARKER_RE =
  /(บ้านเลขที่|เลขที่|ที่อยู่|หมู่บ้าน|คอนโด|อาคาร|ซอย|ซ\.\s?|ถนน|ถ\.\s?|แขวง|เขต|ตำบล|ต\.\s?|อำเภอ|อ\.\s?|จังหวัด|จ\.\s?|หมู่\s?\d|\d{1,4}\/\d{1,4}(?=\s*(?:ซ|ถ|หมู่)))/;
/** Words that end a captured name (Thai has no spaces between words). */
const NAME_STOP_WORDS = ['สั่ง', 'เอา', 'ขอ', 'ส่ง', 'ค่ะ', 'คะ', 'ครับ', 'นะ', 'จ้า', 'จ้ะ', 'ด้วย', 'หน่อย', 'มี', 'ไหม', 'มั้ย'];

interface Replacer {
  map: PiiMap;
  counters: Record<PiiKind, number>;
}

function token(r: Replacer, kind: PiiKind, value: string): string {
  const existing = Object.entries(r.map).find(([t, v]) => v === value && t.startsWith(`[${kind}_`));
  if (existing) return existing[0];
  r.counters[kind] += 1;
  const t = `[${kind}_${r.counters[kind]}]`;
  r.map[t] = value;
  return t;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function stripPII(input: string, ctx: PiiContext): { text: string; map: PiiMap; count: number } {
  const r: Replacer = { map: {}, counters: { PHONE: 0, EMAIL: 0, URL: 0, NAME: 0, ADDR: 0, ACCT: 0 } };
  const aliases = [...ctx.productAliases].filter((a) => a.length >= 2).sort((a, b) => b.length - a.length);
  let text = input;

  text = text.replace(URL_RE, (m) => token(r, 'URL', m));
  text = text.replace(EMAIL_RE, (m) => token(r, 'EMAIL', m));
  text = text.replace(PHONE_RE, (m) => token(r, 'PHONE', m));
  text = text.replace(ACCT_DASHED_RE, (m) => token(r, 'ACCT', m));
  text = text.replace(ACCT_RUN_RE, (m) => token(r, 'ACCT', m));

  // Known names (longest first)
  for (const name of [...ctx.knownNames].filter((n) => n && n.trim().length >= 2).sort((a, b) => b.length - a.length)) {
    const n = name.trim();
    if (aliases.includes(n)) continue;
    text = text.replace(new RegExp(escapeRe(n), 'g'), (m) => token(r, 'NAME', m));
  }

  // Honorific + name, truncated at the first stop word / product alias
  text = text.replace(HONORIFIC_RE, (whole, hon: string, rest: string) => {
    let cut = rest.length;
    for (const w of [...NAME_STOP_WORDS, ...aliases]) {
      const i = rest.indexOf(w);
      if (i >= 0 && i < cut) cut = i;
    }
    const name = rest.slice(0, cut);
    if (name.length < 2 || name.startsWith('[')) return whole;
    const sep = whole.slice(hon.length, whole.length - rest.length);
    return `${hon}${sep}${token(r, 'NAME', name)}${rest.slice(cut)}`;
  });

  // Address fragments: from the first marker to end of line (or the next product alias)
  text = text
    .split('\n')
    .map((line) => {
      const m = ADDRESS_MARKER_RE.exec(line);
      if (!m) return line;
      const start = m.index;
      let end = line.length;
      for (const a of aliases) {
        const i = line.indexOf(a, start + m[0].length);
        if (i >= 0 && i < end) end = i;
      }
      const frag = line.slice(start, end).trimEnd();
      if (frag.length < 3) return line;
      return line.slice(0, start) + token(r, 'ADDR', frag) + line.slice(start + frag.length);
    })
    .join('\n');

  text = text.replace(POSTCODE_RE, (m) => token(r, 'ADDR', m));

  return { text, map: r.map, count: Object.keys(r.map).length };
}

/** Deep-replace tokens back with the original values in every string. */
export function restorePII<T>(value: T, map: PiiMap): T {
  const tokens = Object.keys(map);
  if (tokens.length === 0) return value;
  const re = new RegExp(tokens.map(escapeRe).join('|'), 'g');
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(re, (t) => map[t] ?? t);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/**
 * Throws PiiLeakError if the payload still contains a phone number, account number,
 * e-mail or a known name. Binary image parts should be excluded by the caller.
 */
export function assertNoPII(payload: unknown, ctx: Pick<PiiContext, 'knownNames'> & { extraSpans?: string[] }): void {
  const s = thaiDigitsToArabic(JSON.stringify(payload));
  const kinds = new Set<PiiKind>();
  if (new RegExp(PHONE_RE.source).test(s)) kinds.add('PHONE');
  if (new RegExp(EMAIL_RE.source).test(s)) kinds.add('EMAIL');
  if (new RegExp(ACCT_DASHED_RE.source).test(s)) kinds.add('ACCT');
  for (const n of [...ctx.knownNames, ...(ctx.extraSpans ?? [])]) {
    if (n && n.trim().length >= 2 && s.includes(n.trim())) kinds.add('NAME');
  }
  if (kinds.size) throw new PiiLeakError([...kinds]);
}
