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

let weatherCache: { data: ParsedWeather; timestamp: number } | null = null;
let hourlyCache: HourlyEntry[] | null = null;
let hourlyCacheDate = '';  // YYYY-MM-DD

const WEATHER_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes max cache age

export async function fetchWeather(location: string): Promise<ParsedWeather> {
  // Return fresh cache (< 30 min old)
  if (weatherCache && (Date.now() - weatherCache.timestamp) < WEATHER_CACHE_TTL_MS) {
    return weatherCache.data;
  }

  // Fetch from all sources in parallel
  const results = await Promise.allSettled([
    fetchWeatherWttrIn(location),
    fetchWeatherOpenMeteo(location),
    fetchWeatherMetNorway(location),
    fetchWeatherCurrentUV(location),
  ]);

  const sources: ParsedWeather[] = [];
  const sourceNames = ['wttr.in', 'Open-Meteo', 'MET Norway', 'CurrentUVIndex'];
  for (const r of results) {
    if (r.status === 'fulfilled') sources.push(r.value);
  }

  if (sources.length === 0) {
    const errors = results.map((r, i) =>
      r.status === 'rejected' ? `${sourceNames[i]}: ${(r.reason as Error).message}` : '',
    ).filter(Boolean).join(' | ');
    throw new Error(`All weather sources failed: ${errors}`);
  }

  // Merge: average numeric values, exclude sentinels (UV=-1: no UV, temp=-999: no temp, precip=-1: no precip)
  const uvSources = sources.filter(s => s.uvIndex >= 0);
  const tempSources = sources.filter(s => s.tempC > -900);
  const precipSources = sources.filter(s => s.precipMM >= 0);
  const merged: ParsedWeather = {
    raw: sources.map(s => s.raw).join(' + '),
    condition: sources.find(s => s.condition)?.condition || 'Unknown',
    tempC: tempSources.length > 0
      ? Math.round(tempSources.reduce((s, w) => s + w.tempC, 0) / tempSources.length)
      : 20,
    precipMM: precipSources.length > 0
      ? +(precipSources.reduce((s, w) => s + w.precipMM, 0) / precipSources.length).toFixed(1)
      : 0,
    uvIndex: uvSources.length > 0
      ? Math.round(uvSources.reduce((s, w) => s + w.uvIndex, 0) / uvSources.length)
      : 0,
    sunrise: sources.find(s => s.sunrise)?.sunrise || sunTable[new Date().getMonth()][0],
    sunset: sources.find(s => s.sunset)?.sunset || sunTable[new Date().getMonth()][1],
  };

  weatherCache = { data: merged, timestamp: Date.now() };
  return merged;
}

async function fetchWeatherWttrIn(location: string): Promise<ParsedWeather> {
  const url = `https://wttr.in/${encodeURIComponent(location)}?format=%C+%t+%p+%u\\n%S\\n%s`;
  const data = await httpRequest(url, { method: 'GET', timeout: 10000 });
  const lines = data.trim().split('\n');
  const parsed = parseWeatherString(lines[0].trim());
  if (lines.length >= 3) {
    parsed.sunrise = lines[1].trim().slice(0, 5);
    parsed.sunset = lines[2].trim().slice(0, 5);
  }
  if (!parsed.sunrise || !parsed.sunset) {
    const m = new Date().getMonth();
    parsed.sunrise = sunTable[m][0];
    parsed.sunset = sunTable[m][1];
  }
  return parsed;
}

export async function fetchHourlyWeather(location: string): Promise<HourlyEntry[]> {
  // Return cache only if same day
  const today = new Date().toISOString().slice(0, 10);
  if (hourlyCache && hourlyCacheDate === today) {
    return hourlyCache;
  }

  // Invalidate stale cache from previous day
  hourlyCache = null;
  hourlyCacheDate = '';

  // Fetch from all sources in parallel
  const results = await Promise.allSettled([
    fetchHourlyWttrIn(location),
    fetchHourlyOpenMeteo(location),
    fetchHourlyMetNorway(location),
    fetchHourlyCurrentUV(location),
  ]);

  const allEntries: HourlyEntry[][] = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.length > 0) allEntries.push(r.value);
  }

  if (allEntries.length === 0) return [];

  // Merge: average values across sources for each hour
  const merged = mergeHourlyEntries(allEntries);
  hourlyCache = merged;
  hourlyCacheDate = today;
  return merged;
}

async function fetchHourlyWttrIn(location: string): Promise<HourlyEntry[]> {
  const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
  const data = await httpRequest(url, { method: 'GET', timeout: 15000 });
  const json = JSON.parse(data);
  const hours = json?.weather?.[0]?.hourly;
  if (!Array.isArray(hours)) throw new Error('No hourly data');
  return hours.map((h: any) => ({
    hour: Math.floor(parseInt(h.time || '0', 10) / 100),
    uvIndex: parseInt(h.uvIndex || '0', 10),
    tempC: parseInt(h.tempC || '20', 10),
    condition: h.weatherDesc?.[0]?.value || 'Unknown',
  }));
}

function mergeHourlyEntries(allEntries: HourlyEntry[][]): HourlyEntry[] {
  // Build a map of hour → values from all sources
  // Sentinels: UV=-1 means no UV from this source, temp=-999 means no temp
  const hourMap = new Map<number, { uvSum: number; uvCount: number; tempSum: number; tempCount: number; condition: string }>();
  for (const entries of allEntries) {
    for (const e of entries) {
      const existing = hourMap.get(e.hour);
      const hasUV = e.uvIndex >= 0;
      const hasTemp = e.tempC > -900;
      if (existing) {
        if (hasUV) { existing.uvSum += e.uvIndex; existing.uvCount++; }
        if (hasTemp) { existing.tempSum += e.tempC; existing.tempCount++; }
        if (!existing.condition && e.condition) existing.condition = e.condition;
      } else {
        hourMap.set(e.hour, {
          uvSum: hasUV ? e.uvIndex : 0,
          uvCount: hasUV ? 1 : 0,
          tempSum: hasTemp ? e.tempC : 0,
          tempCount: hasTemp ? 1 : 0,
          condition: e.condition,
        });
      }
    }
  }
  return Array.from(hourMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([hour, v]) => ({
      hour,
      uvIndex: v.uvCount > 0 ? Math.round(v.uvSum / v.uvCount) : 0,
      tempC: v.tempCount > 0 ? Math.round(v.tempSum / v.tempCount) : 20,
      condition: v.condition,
    }));
}

// --- Open-Meteo fallback (free, no API key) ---

let geoCache: { lat: number; lon: number } | null = null;

async function geocode(location: string): Promise<{ lat: number; lon: number }> {
  if (geoCache) return geoCache;
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`;
  const data = await httpRequest(url, { method: 'GET', timeout: 10000 });
  const json = JSON.parse(data);
  if (!json.results?.length) throw new Error(`Geocode failed for "${location}"`);
  geoCache = { lat: json.results[0].latitude, lon: json.results[0].longitude };
  return geoCache;
}

const WMO_CONDITIONS: Record<number, string> = {
  0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Foggy', 48: 'Foggy', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 71: 'Light snow', 73: 'Snow',
  80: 'Rain showers', 81: 'Rain showers', 82: 'Heavy rain showers',
  95: 'Thunderstorm', 96: 'Thunderstorm', 99: 'Thunderstorm',
};

async function fetchWeatherOpenMeteo(location: string): Promise<ParsedWeather> {
  const { lat, lon } = await geocode(location);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + `&current=temperature_2m,relative_humidity_2m,cloud_cover,uv_index,precipitation,weather_code`
    + `&daily=sunrise,sunset&timezone=auto&forecast_days=1`;
  const data = await httpRequest(url, { method: 'GET', timeout: 10000 });
  const json = JSON.parse(data);
  const c = json.current || {};
  const daily = json.daily || {};

  const weatherCode = c.weather_code || 0;
  const condition = WMO_CONDITIONS[weatherCode] || 'Unknown';

  const parsed: ParsedWeather = {
    raw: `${condition} +${Math.round(c.temperature_2m || 20)}°C ${(c.precipitation || 0).toFixed(1)}mm ${Math.round(c.uv_index || 0)} (open-meteo)`,
    condition,
    tempC: Math.round(c.temperature_2m || 20),
    precipMM: c.precipitation || 0,
    uvIndex: Math.round(c.uv_index || 0),
    sunrise: (daily.sunrise?.[0] || '').slice(11, 16) || sunTable[new Date().getMonth()][0],
    sunset: (daily.sunset?.[0] || '').slice(11, 16) || sunTable[new Date().getMonth()][1],
  };

  weatherCache = { data: parsed, timestamp: Date.now() };
  return parsed;
}

async function fetchHourlyOpenMeteo(location: string): Promise<HourlyEntry[]> {
  const { lat, lon } = await geocode(location);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + `&hourly=uv_index,temperature_2m,cloud_cover,weather_code`
    + `&timezone=auto&forecast_days=1`;
  const data = await httpRequest(url, { method: 'GET', timeout: 10000 });
  const json = JSON.parse(data);
  const h = json.hourly || {};
  if (!h.time?.length) throw new Error('No hourly data from Open-Meteo');

  const entries: HourlyEntry[] = [];
  for (let i = 0; i < h.time.length; i += 3) { // sample every 3 hours like wttr.in
    const hour = parseInt((h.time[i] || '').slice(11, 13), 10);
    entries.push({
      hour,
      uvIndex: Math.round(h.uv_index?.[i] || 0),
      tempC: Math.round(h.temperature_2m?.[i] || 20),
      condition: WMO_CONDITIONS[h.weather_code?.[i] || 0] || 'Unknown',
    });
  }
  return entries;
}

// --- MET Norway (free, no API key, just User-Agent) ---

const MET_SYMBOL_CONDITIONS: Record<string, string> = {
  clearsky_day: 'Clear', clearsky_night: 'Clear',
  fair_day: 'Mainly clear', fair_night: 'Mainly clear',
  partlycloudy_day: 'Partly cloudy', partlycloudy_night: 'Partly cloudy',
  cloudy: 'Overcast',
  lightrainshowers_day: 'Light rain', lightrainshowers_night: 'Light rain',
  rainshowers_day: 'Rain showers', rainshowers_night: 'Rain showers',
  heavyrainshowers_day: 'Heavy rain', heavyrainshowers_night: 'Heavy rain',
  lightrain: 'Light rain', rain: 'Rain', heavyrain: 'Heavy rain',
  fog: 'Foggy',
};

async function fetchWeatherMetNorway(location: string): Promise<ParsedWeather> {
  const { lat, lon } = await geocode(location);
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}`;
  const data = await httpRequest(url, {
    method: 'GET', timeout: 10000,
    headers: { 'User-Agent': 'homebridge-boiler-ai/1.0 github.com/nivohavi/homebridge-boiler-ai' },
  });
  const json = JSON.parse(data);
  const ts = json?.properties?.timeseries;
  if (!Array.isArray(ts) || !ts.length) throw new Error('No data from MET Norway');

  const now = ts[0];
  const det = now.data.instant.details;
  const symbol = now.data?.next_1_hours?.summary?.symbol_code || '';
  const condition = MET_SYMBOL_CONDITIONS[symbol] || 'Unknown';

  // MET Norway doesn't provide UV — use 0 so it doesn't drag down the average
  // (UV will come from wttr.in and Open-Meteo)
  return {
    raw: `${condition} +${Math.round(det.air_temperature || 20)}°C cloud:${Math.round(det.cloud_area_fraction || 0)}% (met.no)`,
    condition,
    tempC: Math.round(det.air_temperature || 20),
    precipMM: det.precipitation_amount || 0,
    uvIndex: -1, // sentinel: exclude from UV averaging
    sunrise: sunTable[new Date().getMonth()][0],
    sunset: sunTable[new Date().getMonth()][1],
  };
}

async function fetchHourlyMetNorway(location: string): Promise<HourlyEntry[]> {
  const { lat, lon } = await geocode(location);
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}`;
  const data = await httpRequest(url, {
    method: 'GET', timeout: 10000,
    headers: { 'User-Agent': 'homebridge-boiler-ai/1.0 github.com/nivohavi/homebridge-boiler-ai' },
  });
  const json = JSON.parse(data);
  const ts = json?.properties?.timeseries;
  if (!Array.isArray(ts)) throw new Error('No hourly data from MET Norway');

  const entries: HourlyEntry[] = [];
  const seenHours = new Set<number>();
  for (const t of ts) {
    const hour = parseInt((t.time || '').slice(11, 13), 10);
    if (seenHours.has(hour)) continue;
    seenHours.add(hour);
    const det = t.data.instant.details;
    const symbol = t.data?.next_1_hours?.summary?.symbol_code || '';
    entries.push({
      hour,
      uvIndex: -1, // MET Norway doesn't provide UV
      tempC: Math.round(det.air_temperature || 20),
      condition: MET_SYMBOL_CONDITIONS[symbol] || 'Unknown',
    });
    if (entries.length >= 8) break; // ~24h in 3-hour steps
  }
  return entries;
}

// --- CurrentUVIndex.com (free, no API key, UV-only with hourly forecast) ---

async function fetchWeatherCurrentUV(location: string): Promise<ParsedWeather> {
  const { lat, lon } = await geocode(location);
  const url = `https://currentuvindex.com/api/v1/uvi?latitude=${lat}&longitude=${lon}`;
  const data = await httpRequest(url, { method: 'GET', timeout: 10000 });
  const json = JSON.parse(data);
  if (!json.ok) throw new Error('CurrentUVIndex API returned not ok');

  const uvNow = Math.round(json.now?.uvi ?? 0);

  // UV-only source: temp=-999 sentinel to exclude from temp averaging
  return {
    raw: `UV:${uvNow} (currentuvindex.com)`,
    condition: '',
    tempC: -999, // sentinel: exclude from temp averaging
    precipMM: -1, // sentinel: exclude from precip averaging
    uvIndex: uvNow,
    sunrise: '',
    sunset: '',
  };
}

async function fetchHourlyCurrentUV(location: string): Promise<HourlyEntry[]> {
  const { lat, lon } = await geocode(location);
  const url = `https://currentuvindex.com/api/v1/uvi?latitude=${lat}&longitude=${lon}`;
  const data = await httpRequest(url, { method: 'GET', timeout: 10000 });
  const json = JSON.parse(data);
  if (!json.ok) throw new Error('CurrentUVIndex API returned not ok');

  const forecast = json.forecast || [];
  const entries: HourlyEntry[] = [];
  const seenHours = new Set<number>();

  for (const f of forecast) {
    const hour = parseInt((f.time || '').slice(11, 13), 10);
    if (isNaN(hour) || seenHours.has(hour)) continue;
    seenHours.add(hour);
    entries.push({
      hour,
      uvIndex: Math.round(f.uvi ?? 0),
      tempC: -999, // no temp data from this source
      condition: '',
    });
  }
  return entries;
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
