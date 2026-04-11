import { describe, it, expect } from 'vitest';
import { parseAIResponse, buildPrompt } from '../src/prompt';
import { BoilerState } from '../src/state';
import { ParsedWeather } from '../src/weather';
import { BoilerAIConfig } from '../src/settings';

describe('parseAIResponse', () => {
  it('parses standard response', () => {
    const result = parseAIResponse('45|Need to heat for bath', 90);
    expect(result).toEqual({ minutes: 45, report: 'Need to heat for bath' });
  });

  it('parses zero minutes', () => {
    const result = parseAIResponse('0|Tank already hot', 90);
    expect(result).toEqual({ minutes: 0, report: 'Tank already hot' });
  });

  it('handles leading whitespace/newlines', () => {
    const result = parseAIResponse('\n\n  30|Heating needed', 90);
    expect(result).toEqual({ minutes: 30, report: 'Heating needed' });
  });

  it('strips backtick fences', () => {
    const result = parseAIResponse('```\n20|Short heat\n```', 90);
    expect(result).toEqual({ minutes: 20, report: 'Short heat' });
  });

  it('handles pipe in report text', () => {
    const result = parseAIResponse('30|hot | cold scenario', 90);
    expect(result).toEqual({ minutes: 30, report: 'hot | cold scenario' });
  });

  it('rejects REPORT as report text', () => {
    expect(() => parseAIResponse('30|REPORT', 90)).toThrow('No valid MINUTES|REPORT line found');
  });

  it('skips minutes exceeding max', () => {
    expect(() => parseAIResponse('100|Too long', 90)).toThrow('No valid MINUTES|REPORT line found');
  });

  it('skips negative numbers', () => {
    expect(() => parseAIResponse('-5|Negative', 90)).toThrow('No valid MINUTES|REPORT line found');
  });

  it('skips number strings longer than 3 chars', () => {
    expect(() => parseAIResponse('1234|Too many digits', 9999)).toThrow('No valid MINUTES|REPORT line found');
  });

  it('throws when no valid line found', () => {
    expect(() => parseAIResponse('Just some text without pipe', 90)).toThrow('No valid MINUTES|REPORT line found');
  });

  it('picks first valid line from multi-line response', () => {
    const response = 'Some preamble\n15|First valid\n30|Second valid';
    const result = parseAIResponse(response, 90);
    expect(result).toEqual({ minutes: 15, report: 'First valid' });
  });
});

describe('buildPrompt', () => {
  const baseWeather: ParsedWeather = {
    raw: 'Clear +25°C 0.0mm 8',
    condition: 'Clear',
    tempC: 25,
    precipMM: 0,
    uvIndex: 8,
    sunrise: '05:30',
    sunset: '19:45',
  };

  const baseState: BoilerState = {
    boilerOn: false,
    history: [],
    lastEstimatedTemp: 0,
  };

  const baseConfig: BoilerAIConfig = {
    name: 'Boiler AI',
    location: 'Givatayim',
    timezone: 'Asia/Jerusalem',
    geminiApiKey: 'test-key',
    tank: { liters: 150, heaterKw: 2.5, solar: true },
    boilerPlug: { onUrl: '', offUrl: '', method: 'GET' },
    usage: [
      { time: '06:00', label: 'morning wash', liters: 30, temp: 40 },
      { time: '22:00', label: 'shower', liters: 60, temp: 40 },
    ],
    maxDurationMinutes: 90,
    aiTemperature: 0.3,
  };

  it('contains CURRENT STATUS section', () => {
    const prompt = buildPrompt(new Date('2025-07-15T10:00:00Z'), baseWeather, 40, 3.0, baseState, baseConfig, 'Asia/Jerusalem');
    expect(prompt).toContain('=== CURRENT STATUS ===');
  });

  it('contains WEATHER section', () => {
    const prompt = buildPrompt(new Date('2025-07-15T10:00:00Z'), baseWeather, 40, 3.0, baseState, baseConfig, 'Asia/Jerusalem');
    expect(prompt).toContain('=== WEATHER ===');
    expect(prompt).toContain('Clear');
    expect(prompt).toContain('25°C');
  });

  it('contains HOT WATER SCHEDULE with usage entries', () => {
    const prompt = buildPrompt(new Date('2025-07-15T10:00:00Z'), baseWeather, 40, 3.0, baseState, baseConfig, 'Asia/Jerusalem');
    expect(prompt).toContain('=== HOT WATER SCHEDULE ===');
    expect(prompt).toContain('morning wash');
    expect(prompt).toContain('shower');
  });

  it('contains solar info when solar=true', () => {
    const prompt = buildPrompt(new Date('2025-07-15T10:00:00Z'), baseWeather, 40, 3.0, baseState, baseConfig, 'Asia/Jerusalem');
    expect(prompt).toContain('solar boiler');
    expect(prompt).toContain('Sunrise');
    expect(prompt).toContain('UV Index');
    expect(prompt).toContain('Solar gain');
  });

  it('omits solar info when solar=false', () => {
    const config = { ...baseConfig, tank: { liters: 150, heaterKw: 2.5, solar: false } };
    const prompt = buildPrompt(new Date('2025-07-15T10:00:00Z'), baseWeather, 40, 3.0, baseState, config, 'Asia/Jerusalem');
    expect(prompt).toContain('electric-only');
    expect(prompt).not.toContain('Sunrise');
    expect(prompt).not.toContain('UV Index');
    expect(prompt).not.toContain('Solar gain');
  });

  it('contains HEATING ESTIMATES section', () => {
    const prompt = buildPrompt(new Date('2025-07-15T10:00:00Z'), baseWeather, 40, 3.0, baseState, baseConfig, 'Asia/Jerusalem');
    expect(prompt).toContain('=== HEATING ESTIMATES (projected without heating) ===');
  });

  it('contains YOUR DECISION section', () => {
    const prompt = buildPrompt(new Date('2025-07-15T10:00:00Z'), baseWeather, 40, 3.0, baseState, baseConfig, 'Asia/Jerusalem');
    expect(prompt).toContain('=== YOUR DECISION ===');
    expect(prompt).toContain('NUMBER');
  });
});
