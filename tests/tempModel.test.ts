import { describe, it, expect } from 'vitest';
import { clampTemp, simulateWindow, estimateTankTemp } from '../src/tempModel';
import { ParsedWeather } from '../src/weather';
import { BoilerState } from '../src/state';

const baseWeather: ParsedWeather = {
  raw: 'Clear +25°C 0.0mm 8',
  condition: 'Clear',
  tempC: 25,
  precipMM: 0,
  uvIndex: 8,
  sunrise: '05:30',
  sunset: '19:45',
};

describe('clampTemp', () => {
  it('returns input when in range', () => {
    expect(clampTemp(45, 20)).toBe(45);
  });

  it('clamps to ambient when below', () => {
    expect(clampTemp(10, 20)).toBe(20);
  });

  it('uses 15 as floor when ambient is below 15', () => {
    expect(clampTemp(10, 5)).toBe(15);
  });

  it('clamps to 70 when above', () => {
    expect(clampTemp(80, 20)).toBe(70);
  });

  it('returns ambient when temp equals ambient', () => {
    expect(clampTemp(20, 20)).toBe(20);
  });
});

describe('simulateWindow', () => {
  it('returns start temp for zero-length window', () => {
    const ms = Date.now();
    expect(simulateWindow(50, baseWeather, ms, ms, true, 'Asia/Jerusalem')).toBe(50);
  });

  it('loses heat over time in non-solar mode', () => {
    const from = new Date('2025-07-15T22:00:00+03:00').getTime();
    const to = new Date('2025-07-16T02:00:00+03:00').getTime(); // 4 hours later
    const result = simulateWindow(50, baseWeather, from, to, false, 'Asia/Jerusalem');
    // 4 hours × 0.4 loss = 1.6 loss → 48.4
    expect(result).toBeCloseTo(48.4, 0);
  });

  it('loses heat at night in solar mode', () => {
    const from = new Date('2025-07-15T22:00:00+03:00').getTime();
    const to = new Date('2025-07-16T02:00:00+03:00').getTime(); // 4 hours
    const result = simulateWindow(50, baseWeather, from, to, true, 'Asia/Jerusalem');
    // Night: 4 hours × 0.5 loss = 2.0 → 48.0
    expect(result).toBeCloseTo(48.0, 0);
  });
});

describe('estimateTankTemp', () => {
  it('returns seasonal default with no history and no estimate', () => {
    const state: BoilerState = { boilerOn: false, history: [], lastEstimatedTemp: 0 };

    // Summer (July)
    expect(estimateTankTemp(state, baseWeather, new Date('2025-07-15T12:00:00Z'), { liters: 150, heaterKw: 2.5, solar: true }, 'Asia/Jerusalem')).toBe(45);

    // Winter (January)
    expect(estimateTankTemp(state, baseWeather, new Date('2025-01-15T12:00:00Z'), { liters: 150, heaterKw: 2.5, solar: true }, 'Asia/Jerusalem')).toBe(25);

    // Shoulder (April)
    expect(estimateTankTemp(state, baseWeather, new Date('2025-04-15T12:00:00Z'), { liters: 150, heaterKw: 2.5, solar: true }, 'Asia/Jerusalem')).toBe(35);
  });

  it('decays from stored estimate when no boiler run', () => {
    const now = new Date('2025-07-15T14:00:00+03:00');
    const twoHoursAgo = new Date(now.getTime() - 2 * 3600 * 1000).toISOString();
    const state: BoilerState = {
      boilerOn: false,
      history: [],
      lastEstimatedTemp: 50,
      lastEstimatedAt: twoHoursAgo,
    };

    const result = estimateTankTemp(state, baseWeather, now, { liters: 150, heaterKw: 2.5, solar: true }, 'Asia/Jerusalem');
    // Starts at 50, loses some heat but gains solar — should stay in reasonable range
    expect(result).toBeLessThanOrEqual(70);
    expect(result).toBeGreaterThanOrEqual(40);
  });

  it('applies heating gain from boiler run after estimate', () => {
    const now = new Date('2025-07-15T14:00:00+03:00');
    const threeHoursAgo = new Date(now.getTime() - 3 * 3600 * 1000);
    const twoHoursAgo = new Date(now.getTime() - 2 * 3600 * 1000);
    const almostTwoHoursAgo = new Date(twoHoursAgo.getTime() + 30 * 60 * 1000); // 30 min run

    const state: BoilerState = {
      boilerOn: false,
      history: [{
        startedAt: twoHoursAgo.toISOString(),
        finishedAt: almostTwoHoursAgo.toISOString(),
        durationMins: 30,
        weather: 'Clear',
        tempC: 25,
        uvIndex: 8,
        condition: 'Clear',
        aiReport: 'test',
        trigger: 'scheduler',
      }],
      lastEstimatedTemp: 35,
      lastEstimatedAt: threeHoursAgo.toISOString(),
    };

    const result = estimateTankTemp(state, baseWeather, now, { liters: 150, heaterKw: 2.5, solar: true }, 'Asia/Jerusalem');
    // 35 + decay for 1 hr + 30min heating (~7°C) + decay for ~1.5hr
    // Should be significantly higher than 35
    expect(result).toBeGreaterThan(38);
    expect(result).toBeLessThanOrEqual(70);
  });
});
