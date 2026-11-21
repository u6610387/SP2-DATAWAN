/** Dynamic PromptPay QR payload (EMVCo string). The LIFF renders it as a QR image client-side. */
import generatePayload from 'promptpay-qr';
import { satangToBaht } from '@datawan/shared';

export function buildPromptPayPayload(promptpayId: string, totalSatang: number): string {
  if (!Number.isInteger(totalSatang) || totalSatang <= 0) throw new RangeError(`invalid total: ${totalSatang}`);
  return generatePayload(promptpayId, { amount: satangToBaht(totalSatang) });
}
