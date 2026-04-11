import { describe, it, expect } from 'vitest';
import { heatingRate, usageDrop, deriveSchedule, parseTimeOfDay } from '../src/settings';

describe('heatingRate', () => {
  it('calculates correctly for 150L 2.5kW tank', () => {
    const rate = heatingRate({ liters: 150, heaterKw: 2.5, solar: true });
    // (2.5 * 60) / (150 * 4.186) = 150 / 627.9 ≈ 0.2389
    expect(rate).toBeCloseTo(0.2389, 3);
  });

  it('calculates correctly for 120L 2.5kW tank', () => {
    const rate = heatingRate({ liters: 120, heaterKw: 2.5, solar: true });
    // (2.5 * 60) / (120 * 4.186) = 150 / 502.32 ≈ 0.2988
    expect(rate).toBeCloseTo(0.2988, 3);
  });

  it('handles small tank', () => {
    const rate = heatingRate({ liters: 30, heaterKw: 1, solar: false });
    // (1 * 60) / (30 * 4.186) = 60 / 125.58 ≈ 0.4777
    expect(rate).toBeCloseTo(0.4777, 3);
  });

  it('handles large tank', () => {
    const rate = heatingRate({ liters: 500, heaterKw: 10, solar: true });
    // (10 * 60) / (500 * 4.186) = 600 / 2093 ≈ 0.2866
    expect(rate).toBeCloseTo(0.2866, 3);
  });
});

describe('usageDrop', () => {
  it('standard case: 50L from 120L tank', () => {
    const drop = usageDrop({ liters: 120, heaterKw: 2.5, solar: true }, 50);
    // (50/120) * 20 ≈ 8.333
    expect(drop).toBeCloseTo(8.333, 2);
  });

  it('full tank draw', () => {
    const drop = usageDrop({ liters: 120, heaterKw: 2.5, solar: true }, 120);
    expect(drop).toBe(20);
  });

  it('small draw', () => {
    const drop = usageDrop({ liters: 150, heaterKw: 2.5, solar: true }, 10);
    // (10/150) * 20 ≈ 1.333
    expect(drop).toBeCloseTo(1.333, 2);
  });
});

describe('deriveSchedule', () => {
  it('derives check times 1 hour before usage', () => {
    const schedule = deriveSchedule([
      { time: '06:00', label: 'morning', liters: 30, temp: 40 },
      { time: '18:30', label: 'bath', liters: 50, temp: 42 },
      { time: '22:00', label: 'shower', liters: 60, temp: 40 },
    ]);
    // 06:00 - 60min = 05:00, 18:30 - 60min = 17:00, 22:00 - 60min = 21:00, + 12:00
    expect(schedule).toEqual(['05:00', '12:00', '17:00', '21:00']);
  });

  it('does not duplicate 12:00', () => {
    const schedule = deriveSchedule([
      { time: '13:00', label: 'lunch', liters: 20, temp: 38 },
    ]);
    // 13:00 - 60min = 12:00, no extra 12:00
    expect(schedule).toEqual(['12:00']);
  });

  it('handles single usage entry', () => {
    const schedule = deriveSchedule([
      { time: '08:00', label: 'morning', liters: 30, temp: 40 },
    ]);
    expect(schedule).toEqual(['07:00', '12:00']);
  });

  it('wraps around midnight', () => {
    const schedule = deriveSchedule([
      { time: '00:30', label: 'late', liters: 20, temp: 38 },
    ]);
    // 00:30 - 60min = -30 + 1440 = 1410 = 23:00
    expect(schedule).toContain('23:00');
    expect(schedule).toContain('12:00');
  });

  it('returns sorted output', () => {
    const schedule = deriveSchedule([
      { time: '22:00', label: 'late', liters: 40, temp: 40 },
      { time: '06:00', label: 'morning', liters: 30, temp: 40 },
    ]);
    expect(schedule).toEqual([...schedule].sort());
  });
});

describe('parseTimeOfDay', () => {
  it('parses 06:30 to 390', () => {
    expect(parseTimeOfDay('06:30')).toBe(390);
  });

  it('parses 00:00 to 0', () => {
    expect(parseTimeOfDay('00:00')).toBe(0);
  });

  it('parses 23:59 to 1439', () => {
    expect(parseTimeOfDay('23:59')).toBe(1439);
  });

  it('returns 0 for invalid input', () => {
    expect(parseTimeOfDay('bad')).toBe(0);
  });
});
