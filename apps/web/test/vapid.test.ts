import { describe, expect, it } from 'vitest';
import { subscriptionUsesKey, urlBase64ToUint8Array } from '@/lib/vapid';

const KEY_A = 'BAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0A';
const KEY_B = 'BEBBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWltcXV5fYGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn-AgQ';

describe('subscriptionUsesKey', () => {
  it('is true when the subscription was created with the current key', () => {
    expect(subscriptionUsesKey(urlBase64ToUint8Array(KEY_A).buffer as ArrayBuffer, KEY_A)).toBe(true);
  });

  it('is false after the VAPID key was rotated', () => {
    expect(subscriptionUsesKey(urlBase64ToUint8Array(KEY_A).buffer as ArrayBuffer, KEY_B)).toBe(false);
  });

  it('is false when the browser does not report the key', () => {
    expect(subscriptionUsesKey(null, KEY_A)).toBe(false);
  });
});
