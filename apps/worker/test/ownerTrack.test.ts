/** Owner LINE: Lalamove link as pasted from the app (label + link, no https, own line). */
import { describe, expect, it } from 'vitest';
import { parseOwnerCommand } from '../src/line/ownerCommands';
import { TRACKING_RE } from '../src/handlers/customer';

const U = 'https://share.lalamove.com/?TH1&sign=x';

describe('owner track command', () => {
  it.each([
    [`A7 track ${U}`, 'A7', U],
    [U, null, U],
    [`A7 ${U}`, 'A7', U],
    [`ติดตามสถานะการจัดส่ง: ${U}`, null, U],
    [`A7 ติดตามสถานะการจัดส่ง: ${U}`, 'A7', U],
    ['A7 track share.lalamove.com/?TH1', 'A7', 'https://share.lalamove.com/?TH1'],
    ['A7 track https://courier.example.co.th/t/9', 'A7', 'https://courier.example.co.th/t/9'],
  ])('%s', (text, code, url) => {
    expect(parseOwnerCommand(text)).toEqual({ kind: 'track', code, url });
  });

  it('a non-Lalamove link without "track" is not a dispatch; "track" without a link is unknown', () => {
    expect(parseOwnerCommand('A7 https://example.com/x').kind).not.toBe('track');
    expect(parseOwnerCommand('A7 track').kind).toBe('unknown');
    expect(parseOwnerCommand('A7 1850').kind).toBe('price'); // unchanged
  });
});

describe('customer tracking question', () => {
  it.each(['ขอลิ้งค์ lalamove', 'ขอลิงก์หน่อยค่ะ', 'ลิงก์ส่งของ', 'ถึงไหนแล้วคะ', 'ส่งถึงยัง', 'ไรเดอร์ถึงไหน', 'track'])('%s → tracking', (t) => {
    expect(TRACKING_RE.test(t)).toBe(true);
  });
  it.each(['หอยแครง 2 โล', 'กุ้งแม่น้ำ 1 กก. ส่งพรุ่งนี้', 'ตกลง', '1500 ได้ไหม'])('%s → not tracking', (t) => {
    expect(TRACKING_RE.test(t)).toBe(false);
  });
});
