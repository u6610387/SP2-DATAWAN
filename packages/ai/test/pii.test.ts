import { describe, expect, it } from 'vitest';
import { assertNoPII, PiiLeakError, restorePII, stripPII } from '../src/pii/strip';

const ctx = { knownNames: ['สมศรี ใจดี'], productAliases: ['กุ้งแม่น้ำ', 'ปู', 'หอยแครง'] };

describe('PII strip/restore', () => {
  it('masks phones in several formats', () => {
    for (const p of ['081-234-5678', '0812345678', '081 234 5678', '+66812345678', '02-123-4567']) {
      const { text } = stripPII(`โทร ${p} นะคะ`, ctx);
      expect(text).not.toMatch(/\d{3}/);
      expect(text).toContain('[PHONE_1]');
    }
  });
  it('masks known names, honorific names (stopping at product/verb) and addresses', () => {
    const msg = 'คุณแดงสั่งกุ้งแม่น้ำ 2 โล ส่งให้สมศรี ใจดี\nที่อยู่ 99/1 ซ.เพชรเกษม 48 แขวงบางหว้า 10160';
    const { text, map } = stripPII(msg, ctx);
    expect(text).toContain('คุณ[NAME_');
    expect(text).toContain('สั่งกุ้งแม่น้ำ 2 โล');
    expect(text).not.toContain('สมศรี');
    expect(text).not.toContain('เพชรเกษม');
    expect(text).not.toContain('10160');
    expect(restorePII(text, map)).toBe(msg);
  });
  it('does not mask "พี่คะ" addressing the shop', () => {
    expect(stripPII('พี่คะ เอาปู 1 โล', ctx).text).toBe('พี่คะ เอาปู 1 โล');
  });
  it('assertNoPII throws on leaks and passes clean payloads', () => {
    expect(() => assertNoPII({ m: 'โทร 0812345678' }, ctx)).toThrow(PiiLeakError);
    expect(() => assertNoPII({ m: 'ส่งให้สมศรี ใจดี' }, ctx)).toThrow(PiiLeakError);
    expect(() => assertNoPII({ m: 'กุ้งแม่น้ำ 2 โล [PHONE_1]' }, ctx)).not.toThrow();
  });
});

describe('PII false positives', () => {
  it('keeps everyday words', () => {
    for (const s of ['สั่งเหมือนอาทิตย์ที่แล้ว', 'ขอบคุณค่ะ', 'ส่งพรุ่งนี้เช้า', 'ปู 1 โลครึ่ง']) expect(stripPII(s, ctx).text).toBe(s);
  });
});
