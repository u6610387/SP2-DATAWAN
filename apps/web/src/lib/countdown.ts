/** Pure countdown formatting, used by components/Countdown.tsx. */
export function formatRemaining(remainingMs: number): string {
  if (remainingMs <= 0) return 'หมดเวลาแล้ว';
  const mm = Math.floor(remainingMs / 60_000);
  const ss = Math.floor((remainingMs % 60_000) / 1000);
  return `เหลือเวลา ${mm}:${String(ss).padStart(2, '0')} นาที`;
}
