export const PLUGIN_NAME = 'homebridge-boiler-ai';
export const PLATFORM_NAME = 'BoilerAI';

export interface UsageEntry {
  time: string;   // HH:MM
  label: string;
  liters: number;
  temp: number;   // target °C
}

export interface BoilerPlugConfig {
  onUrl: string;
  offUrl: string;
  method: string;     // GET or POST
  headers?: string;   // JSON string of headers
  body?: string;      // request body
}

export interface TankConfig {
  liters: number;
  heaterKw: number;
  solar: boolean;
}

export interface BoilerAIConfig {
  name: string;
  location: string;
  timezone: string;
  geminiApiKey?: string;
  xaiApiKey?: string;
  tank: TankConfig;
  boilerPlug: BoilerPlugConfig;
  usage: UsageEntry[];
  maxDurationMinutes: number;
  aiTemperature: number;
}

export function heatingRate(tank: TankConfig): number {
  // °C per minute: power / (volume × specific heat)
  return (tank.heaterKw * 60) / (tank.liters * 4.186);
}

export function usageDrop(tank: TankConfig, liters: number): number {
  const ratio = liters / tank.liters;
  return ratio * 20; // empirical stratification-adjusted delta
}

export function deriveSchedule(usage: UsageEntry[]): string[] {
  const seen = new Set<string>();
  const times: string[] = [];

  for (const u of usage) {
    const [h, m] = u.time.split(':').map(Number);
    let checkMins = h * 60 + m - 60;
    if (checkMins < 0) checkMins += 24 * 60;
    const ct = `${String(Math.floor(checkMins / 60)).padStart(2, '0')}:00`;
    if (!seen.has(ct)) {
      seen.add(ct);
      times.push(ct);
    }
  }

  if (!seen.has('12:00')) {
    times.push('12:00');
  }

  return times.sort();
}

export function parseTimeOfDay(hhmm: string): number {
  const parts = hhmm.split(':');
  if (parts.length < 2) return 0;
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}
