import * as fs from 'fs';
import * as path from 'path';

export interface RunRecord {
  startedAt: string;   // ISO date string
  finishedAt: string;
  durationMins: number;
  weather: string;
  tempC: number;
  uvIndex: number;
  condition: string;
  aiReport: string;
  trigger: string;
}

export interface BoilerState {
  boilerOn: boolean;
  runStartedAt?: string;
  runDurationMin?: number;
  history: RunRecord[];
  lastEstimatedTemp: number;
  lastEstimatedAt?: string;
}

const MAX_HISTORY = 30;

export function loadState(storagePath: string): BoilerState {
  const filePath = path.join(storagePath, 'boiler_state.json');
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    const state = JSON.parse(data) as BoilerState;
    if (!state.history) state.history = [];
    return state;
  } catch {
    return { boilerOn: false, history: [], lastEstimatedTemp: 0 };
  }
}

export function saveState(storagePath: string, state: BoilerState): void {
  const filePath = path.join(storagePath, 'boiler_state.json');
  const tmpPath = filePath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
    fs.renameSync(tmpPath, filePath);
  } catch {
    // best effort
  }
}

export function appendHistory(state: BoilerState, record: RunRecord): void {
  state.history.push(record);
  if (state.history.length > MAX_HISTORY) {
    state.history = state.history.slice(state.history.length - MAX_HISTORY);
  }
}

export function lastRun(state: BoilerState): RunRecord | null {
  if (state.history.length === 0) return null;
  return state.history[state.history.length - 1];
}
