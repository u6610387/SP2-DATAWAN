/**
 * Thai bank "slip verify" Mini-QR parser (EMV-style TLV):
 *   00 { 00 API ID "000001", 01 sending bank (3-digit BOT code), 02 transRef } · 51 "TH" · 91 CRC-16/CCITT-FALSE
 * The published example below was checked in-session: its CRC (17DF) recomputes exactly, and a
 * real production KBANK slip decoded to the same layout (00(41) 51(2) 91(4); 00>00=000001,
 * 00>01=004, 00>02 20 chars) with a valid CRC.
 */
import { describe, expect, it } from 'vitest';
import { buildSlipQrForTest, crc16ccitt, parseSlipQr } from '../src/services/slipQr';

const EXAMPLE = '004100060000010103014022000111222233344ABCD125102TH910417DF';

describe('parseSlipQr', () => {
  it('parses the published example', () => {
    expect(parseSlipQr(EXAMPLE)).toEqual({ ok: true, apiId: '000001', sendingBank: '014', transRef: '00111222233344ABCD12' });
  });

  it('CRC is CRC-16/CCITT-FALSE over everything up to and including "9104"', () => {
    expect(crc16ccitt(EXAMPLE.slice(0, -4))).toBe('17DF');
  });

  it('accepts a lowercase CRC and surrounding whitespace', () => {
    expect(parseSlipQr(` ${EXAMPLE.slice(0, -4)}17df\n`).ok).toBe(true);
  });

  it('rejects a tampered reference (CRC no longer matches)', () => {
    const tampered = EXAMPLE.replace('ABCD12', 'ABCD13');
    expect(parseSlipQr(tampered)).toEqual({ ok: false, reason: 'BAD_CRC' });
  });

  it('rejects a PromptPay payment QR and other non-slip QR codes', () => {
    const promptpay = '00020101021129370016A000000677010111011300668123456785802TH530376463041234';
    expect(parseSlipQr(promptpay)).toMatchObject({ ok: false, reason: 'NOT_SLIP_QR' });
    expect(parseSlipQr('https://example.com')).toMatchObject({ ok: false, reason: 'NOT_SLIP_QR' });
    expect(parseSlipQr('')).toMatchObject({ ok: false, reason: 'NOT_SLIP_QR' });
  });

  it('rejects a slip QR for another country or API', () => {
    expect(parseSlipQr(buildSlipQrForTest('014', 'REF1234567890', { country: 'SG' }))).toMatchObject({ ok: false, reason: 'NOT_SLIP_QR' });
    expect(parseSlipQr(buildSlipQrForTest('014', 'REF1234567890', { apiId: '000009' }))).toMatchObject({ ok: false, reason: 'NOT_SLIP_QR' });
  });

  it('round-trips the test builder', () => {
    const qr = buildSlipQrForTest('004', '016330112233ABCDEFGH');
    expect(parseSlipQr(qr)).toEqual({ ok: true, apiId: '000001', sendingBank: '004', transRef: '016330112233ABCDEFGH' });
  });
});
