import { describe, expect, it } from 'vitest';
import { formatRemaining } from '../src/lib/countdown';

describe('formatRemaining', () => {
  it('shows minutes:seconds for positive remaining time', () => {
    expect(formatRemaining(125_000)).toBe('เหลือเวลา 2:05 นาที');
    expect(formatRemaining(60_000)).toBe('เหลือเวลา 1:00 นาที');
    expect(formatRemaining(5_000)).toBe('เหลือเวลา 0:05 นาที');
  });

  it('reports expired at zero or negative', () => {
    expect(formatRemaining(0)).toBe('หมดเวลาแล้ว');
    expect(formatRemaining(-1000)).toBe('หมดเวลาแล้ว');
  });
});
