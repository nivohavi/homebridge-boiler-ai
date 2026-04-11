import { describe, it, expect } from 'vitest';
import { appendHistory, lastRun, BoilerState, RunRecord } from '../src/state';

function makeRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    startedAt: '2025-07-15T10:00:00Z',
    finishedAt: '2025-07-15T10:30:00Z',
    durationMins: 30,
    weather: 'Clear +25°C 0.0mm 8',
    tempC: 25,
    uvIndex: 8,
    condition: 'Clear',
    aiReport: 'Heating for bath',
    trigger: 'scheduler',
    ...overrides,
  };
}

describe('lastRun', () => {
  it('returns null for empty history', () => {
    const state: BoilerState = { boilerOn: false, history: [], lastEstimatedTemp: 0 };
    expect(lastRun(state)).toBeNull();
  });

  it('returns last element', () => {
    const first = makeRecord({ durationMins: 10 });
    const second = makeRecord({ durationMins: 20 });
    const state: BoilerState = { boilerOn: false, history: [first, second], lastEstimatedTemp: 0 };
    expect(lastRun(state)).toEqual(second);
  });
});

describe('appendHistory', () => {
  it('appends a record', () => {
    const state: BoilerState = { boilerOn: false, history: [], lastEstimatedTemp: 0 };
    const record = makeRecord();
    appendHistory(state, record);
    expect(state.history).toHaveLength(1);
    expect(state.history[0]).toEqual(record);
  });

  it('trims to 30 entries when exceeding MAX_HISTORY', () => {
    const state: BoilerState = { boilerOn: false, history: [], lastEstimatedTemp: 0 };
    for (let i = 0; i < 35; i++) {
      appendHistory(state, makeRecord({ durationMins: i }));
    }
    expect(state.history).toHaveLength(30);
    // Oldest entries should be trimmed — first remaining should be entry #5
    expect(state.history[0].durationMins).toBe(5);
    expect(state.history[29].durationMins).toBe(34);
  });

  it('keeps exactly 30 when at limit', () => {
    const state: BoilerState = { boilerOn: false, history: [], lastEstimatedTemp: 0 };
    for (let i = 0; i < 30; i++) {
      appendHistory(state, makeRecord({ durationMins: i }));
    }
    expect(state.history).toHaveLength(30);
    appendHistory(state, makeRecord({ durationMins: 99 }));
    expect(state.history).toHaveLength(30);
    expect(state.history[29].durationMins).toBe(99);
  });
});
