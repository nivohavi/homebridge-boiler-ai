import { httpRequest } from './ai';

export interface ParsedWeather {
  raw: string;
  condition: string;
  tempC: number;
  precipMM: number;
  uvIndex: number;
  sunrise: string;  // HH:MM
  sunset: string;   // HH:MM
}

// Fallback sunrise/sunset table (Israel, used only when API fails)
const sunTable: [string, string][] = [
  ['06:40', '17:00'], ['06:20', '17:30'], ['05:50', '17:55'],
  ['06:15', '19:20'], ['05:40', '19:40'], ['05:30', '19:50'],
  ['05:40', '19:45'], ['05:55', '19:20'], ['06:10', '18:40'],
  ['06:30', '18:00'], ['06:00', '16:40'], ['06:30', '16:40'],
];

export interface HourlyEntry {
  hour: number;      // 0-23
  uvIndex: number;
  tempC: number;
  condition: string;
}

let weatherCache: ParsedWeather | null = null;
let hourlyCache: HourlyEntry[] | null = null;
let hourlyCacheDate = '';  // YYYY-MM-DD

export async function fetchWeather(location: string): Promise<ParsedWeather> {
  try {
    const url = `https://wttr.in/${encodeURIComponent(location)}?format=%C+%t+%p+%u\\n%S\\n%s`;
    const data = await httpRequest(url, { method: 'GET', timeout: 10000 });
    const lines = data.trim().split('\n');
    const raw = lines[0].trim();
    const parsed = parseWeatherString(raw);

    if (lines.length >= 3) {
      parsed.sunrise = lines[1].trim().slice(0, 5); // HH:MM from HH:MM:SS
      parsed.sunset = lines[2].trim().slice(0, 5);
    }
    if (!parsed.sunrise || !parsed.sunset) {
      const m = new Date().getMonth();
      parsed.sunrise = sunTable[m][0];
      parsed.sunset = sunTable[m][1];
    }

    weatherCache = parsed;
    return parsed;
  } catch {
    if (weatherCache) {
      return { ...weatherCache, raw: weatherCache.raw + ' (cached)' };
    }
    const m = new Date().getMonth();
    return {
      raw: 'Unknown', condition: 'Unknown',
      tempC: 20, precipMM: 0, uvIndex: 3,
      sunrise: sunTable[m][0], sunset: sunTable[m][1],
    };
  }
}

export async function fetchHourlyWeather(location: string): Promise<HourlyEntry[]> {
  // Return cache if same day
  const today = new Date().toISOString().slice(0, 10);
  if (hourlyCache && hourlyCacheDate === today) {
    return hourlyCache;
  }

  try {
    const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
    const data = await httpRequest(url, { method: 'GET', timeout: 15000 });
    const json = JSON.parse(data);
    const hours = json?.weather?.[0]?.hourly;
    if (!Array.isArray(hours)) return hourlyCache || [];

    const entries: HourlyEntry[] = hours.map((h: any) => ({
      hour: Math.floor(parseInt(h.time || '0', 10) / 100),
      uvIndex: parseInt(h.uvIndex || '0', 10),
      tempC: parseInt(h.tempC || '20', 10),
      condition: h.weatherDesc?.[0]?.value || 'Unknown',
    }));

    hourlyCache = entries;
    hourlyCacheDate = today;
    return entries;
  } catch {
    return hourlyCache || [];
  }
}

/**
 * Get UV index for a specific hour from hourly data.
 * Interpolates between the 3-hourly data points wttr.in provides.
 */
export function getHourlyUV(hourly: HourlyEntry[], hour: number): number | null {
  if (!hourly.length) return null;

  // Find the closest entry
  let best = hourly[0];
  for (const e of hourly) {
    if (Math.abs(e.hour - hour) < Math.abs(best.hour - hour)) {
      best = e;
    }
  }
  return best.uvIndex;
}

export function getHourlyCondition(hourly: HourlyEntry[], hour: number): string | null {
  if (!hourly.length) return null;

  let best = hourly[0];
  for (const e of hourly) {
    if (Math.abs(e.hour - hour) < Math.abs(best.hour - hour)) {
      best = e;
    }
  }
  return best.condition;
}

function parseWeatherString(raw: string): ParsedWeather {
  const p: ParsedWeather = {
    raw, condition: '', tempC: 0, precipMM: 0, uvIndex: 0,
    sunrise: '', sunset: '',
  };

  const parts = raw.split(/\s+/);
  let tempIdx = -1;

  for (let i = 0; i < parts.length; i++) {
    if (parts[i].includes('°')) {
      tempIdx = i;
      const temp = parts[i].replace('°C', '').replace('°F', '').replace('+', '');
      const v = parseFloat(temp);
      if (!isNaN(v)) p.tempC = v;
      break;
    }
  }

  if (tempIdx > 0) {
    p.condition = parts.slice(0, tempIdx).join(' ');
  } else if (parts.length > 0) {
    p.condition = parts[0];
  }

  for (const part of parts) {
    if (part.endsWith('mm')) {
      const v = parseFloat(part.replace('mm', ''));
      if (!isNaN(v)) p.precipMM = v;
    }
  }

  for (let i = parts.length - 1; i >= 0; i--) {
    const v = parseInt(parts[i], 10);
    if (!isNaN(v) && v >= 0 && v <= 15 && parts[i] === String(v)) {
      p.uvIndex = v;
      break;
    }
  }

  return p;
}

export function cloudFactor(condition: string): number {
  const cond = condition.toLowerCase();
  if (cond.includes('clear') || cond.includes('sunny')) return 1.0;
  if (cond.includes('partly')) return 0.6;
  if (cond.includes('cloudy') || cond.includes('overcast')) return 0.2;
  if (cond.includes('rain') || cond.includes('thunder') || cond.includes('storm')) return 0.05;
  return 0.3;
}

export function seasonalMultiplier(month: number): number {
  // month is 0-indexed (Jan=0)
  const m = month + 1; // convert to 1-indexed
  if (m >= 5 && m <= 9) return 1.2;
  if (m >= 11 || m <= 2) return 0.7;
  return 1.0;
}

export function estimateSolarGainPerHour(weather: ParsedWeather, month: number): number {
  const base = weather.uvIndex * 1.5;
  return base * cloudFactor(weather.condition) * seasonalMultiplier(month);
}

export function isDaylight(hourMinute: number, weather: ParsedWeather): boolean {
  const sunrise = parseHHMM(weather.sunrise);
  const sunset = parseHHMM(weather.sunset);
  return hourMinute >= sunrise && hourMinute <= sunset;
}

function parseHHMM(hhmm: string): number {
  const parts = hhmm.split(':');
  if (parts.length < 2) return 0;
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}
