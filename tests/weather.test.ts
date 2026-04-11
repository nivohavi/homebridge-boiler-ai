import { describe, it, expect } from 'vitest';
import { cloudFactor, seasonalMultiplier, estimateSolarGainPerHour, isDaylight, ParsedWeather } from '../src/weather';

const baseWeather: ParsedWeather = {
  raw: 'Clear +25°C 0.0mm 8',
  condition: 'Clear',
  tempC: 25,
  precipMM: 0,
  uvIndex: 8,
  sunrise: '05:30',
  sunset: '19:45',
};

describe('cloudFactor', () => {
  it('returns 1.0 for clear', () => {
    expect(cloudFactor('Clear')).toBe(1.0);
  });

  it('returns 1.0 for sunny', () => {
    expect(cloudFactor('Sunny')).toBe(1.0);
  });

  it('returns 0.6 for partly cloudy', () => {
    expect(cloudFactor('Partly cloudy')).toBe(0.6);
  });

  it('returns 0.2 for cloudy', () => {
    expect(cloudFactor('Cloudy')).toBe(0.2);
  });

  it('returns 0.2 for overcast', () => {
    expect(cloudFactor('Overcast')).toBe(0.2);
  });

  it('returns 0.05 for rain', () => {
    expect(cloudFactor('Light rain')).toBe(0.05);
  });

  it('returns 0.05 for thunderstorm', () => {
    expect(cloudFactor('Thunderstorm')).toBe(0.05);
  });

  it('returns 0.3 for unknown condition', () => {
    expect(cloudFactor('Haze')).toBe(0.3);
  });
});

describe('seasonalMultiplier', () => {
  it('returns 1.2 for summer months (May-Sep, 0-indexed: 4-8)', () => {
    expect(seasonalMultiplier(4)).toBe(1.2); // May
    expect(seasonalMultiplier(6)).toBe(1.2); // July
    expect(seasonalMultiplier(8)).toBe(1.2); // September
  });

  it('returns 0.7 for winter months (Nov-Feb)', () => {
    expect(seasonalMultiplier(10)).toBe(0.7); // November
    expect(seasonalMultiplier(0)).toBe(0.7);  // January
    expect(seasonalMultiplier(1)).toBe(0.7);  // February
  });

  it('returns 1.0 for shoulder months (Mar-Apr, Oct)', () => {
    expect(seasonalMultiplier(2)).toBe(1.0);  // March
    expect(seasonalMultiplier(3)).toBe(1.0);  // April
    expect(seasonalMultiplier(9)).toBe(1.0);  // October
  });
});

describe('estimateSolarGainPerHour', () => {
  it('calculates correctly for clear summer day', () => {
    // base = 8 * 1.5 = 12, cloudFactor(Clear) = 1.0, seasonal(6=July) = 1.2
    // 12 * 1.0 * 1.2 = 14.4
    const gain = estimateSolarGainPerHour(baseWeather, 6);
    expect(gain).toBeCloseTo(14.4, 1);
  });

  it('returns 0 when UV is 0', () => {
    const weather = { ...baseWeather, uvIndex: 0 };
    expect(estimateSolarGainPerHour(weather, 6)).toBe(0);
  });

  it('reduces gain for cloudy conditions', () => {
    const weather = { ...baseWeather, condition: 'Cloudy' };
    // base = 12, cloudFactor = 0.2, seasonal = 1.2 → 2.88
    expect(estimateSolarGainPerHour(weather, 6)).toBeCloseTo(2.88, 1);
  });

  it('reduces gain in winter', () => {
    // base = 12, cloudFactor = 1.0, seasonal(0=Jan) = 0.7 → 8.4
    expect(estimateSolarGainPerHour(baseWeather, 0)).toBeCloseTo(8.4, 1);
  });
});

describe('isDaylight', () => {
  it('returns true during midday', () => {
    // 12:00 = 720 minutes
    expect(isDaylight(720, baseWeather)).toBe(true);
  });

  it('returns false before sunrise', () => {
    // 04:00 = 240 minutes, sunrise is 05:30 = 330
    expect(isDaylight(240, baseWeather)).toBe(false);
  });

  it('returns false after sunset', () => {
    // 21:00 = 1260 minutes, sunset is 19:45 = 1185
    expect(isDaylight(1260, baseWeather)).toBe(false);
  });

  it('returns true at sunrise', () => {
    // 05:30 = 330
    expect(isDaylight(330, baseWeather)).toBe(true);
  });

  it('returns true at sunset', () => {
    // 19:45 = 1185
    expect(isDaylight(1185, baseWeather)).toBe(true);
  });
});
