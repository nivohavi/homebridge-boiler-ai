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

export interface WeatherResult {
  merged: ParsedWeather;
  sourceDetails: string[];  // per-source summary for logging
}

export async function fetchWeather(location: string, weatherApiKey?: string): Promise<WeatherResult> {
  // Return fresh cache (< 30 min old)
  if (weatherCache && (Date.now() - weatherCache.timestamp) < WEATHER_CACHE_TTL_MS) {
    return { merged: weatherCache.data, sourceDetails: ['(cached)'] };
  }

  // Fetch from all sources in parallel
  const sourceNames = ['Open-Meteo', 'MET Norway', 'CurrentUVIndex', ...(weatherApiKey ? ['WeatherAPI'] : [])];
  const results = await Promise.allSettled([
    fetchWeatherOpenMeteo(location),
    fetchWeatherMetNorway(location),
    fetchWeatherCurrentUV(location),
    ...(weatherApiKey ? [fetchWeatherAPI(location, weatherApiKey)] : []),
  ]);

  const sources: ParsedWeather[] = [];
  const sourceDetails: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      sources.push(r.value);
      const s = r.value;
      const parts: string[] = [];
      if (s.tempC > -900) parts.push(`${s.tempC}°C`);
      if (s.uvIndex >= 0) parts.push(`UV:${s.uvIndex}`);
      if (s.condition) parts.push(s.condition);
      sourceDetails.push(`${sourceNames[i]}: ${parts.join(' ')}`);
    } else {
      sourceDetails.push(`${sourceNames[i]}: FAILED (${(r.reason as Error).message})`);
    }
  }

  if (sources.length === 0) {
    throw new Error(`All weather sources failed: ${sourceDetails.join(' | ')}`);
  }

  // Cross-validate: discard sources whose temp deviates >5°C from the median of others
  const validSources = crossValidate(sources);
  if (validSources.length < sources.length) {
    const discarded = sources.length - validSources.length;
    sourceDetails.push(`(${discarded} source(s) discarded by cross-validation)`);
  }

  // Merge: average numeric values, exclude sentinels
  const uvValues: ParsedWeather[] = validSources.filter(s => s.uvIndex >= 0);
  const tempValues: ParsedWeather[] = validSources.filter(s => s.tempC > -900);
  const precipValues: ParsedWeather[] = validSources.filter(s => s.precipMM >= 0);
  const merged: ParsedWeather = {
    raw: validSources.map(s => s.raw).join(' + '),
    condition: validSources.find(s => s.condition)?.condition || 'Unknown',
    tempC: tempValues.length > 0
      ? Math.round(tempValues.reduce((s, w) => s + w.tempC, 0) / tempValues.length)
      : 20,
    precipMM: precipValues.length > 0
      ? +(precipValues.reduce((s, w) => s + w.precipMM, 0) / precipValues.length).toFixed(1)
      : 0,
    uvIndex: uvValues.length > 0
      ? Math.round(uvValues.reduce((s, w) => s + w.uvIndex, 0) / uvValues.length)
      : 0,
    sunrise: validSources.find(s => s.sunrise)?.sunrise || sunTable[new Date().getMonth()][0],
    sunset: validSources.find(s => s.sunset)?.sunset || sunTable[new Date().getMonth()][1],
  };

  sourceDetails.push(`→ MERGED: ${merged.tempC}°C UV:${merged.uvIndex} ${merged.condition}`);

  weatherCache = { data: merged, timestamp: Date.now() };
  return { merged, sourceDetails };
}

export async function fetchHourlyWeather(location: string, weatherApiKey?: string): Promise<HourlyEntry[]> {
  // Return cache only if same day
  const today = new Date().toISOString().slice(0, 10);
  if (hourlyCache && hourlyCacheDate === today) {
    return hourlyCache;
  }

  // Invalidate stale cache from previous day
  hourlyCache = null;
  hourlyCacheDate = '';

  // Fetch from all sources in parallel (no wttr.in — unreliable)
  const results = await Promise.allSettled([
    fetchHourlyOpenMeteo(location),
    fetchHourlyMetNorway(location),
    fetchHourlyCurrentUV(location),
    ...(weatherApiKey ? [fetchHourlyWeatherAPI(location, weatherApiKey)] : []),
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

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Cross-validate sources: if a source's temp deviates >5°C from the median
 * of the other sources, discard it (it's lying).
 * Only applies when we have 3+ temp sources to compare.
 */
function crossValidate(sources: ParsedWeather[]): ParsedWeather[] {
  const tempSources = sources.filter(s => s.tempC > -900);
  if (tempSources.length < 3) return sources; // not enough to cross-validate

  const temps = tempSources.map(s => s.tempC);
  const med = median(temps);

  return sources.filter(s => {
    if (s.tempC <= -900) return true; // no temp from this source, keep it (has UV or other data)
    const deviation = Math.abs(s.tempC - med);
    return deviation <= 5; // discard if >5°C from median
  });
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

// --- WeatherAPI.com (free key, full weather + UV + hourly) ---

async function fetchWeatherAPI(location: string, apiKey: string): Promise<ParsedWeather> {
  const { lat, lon } = await geocode(location);
  const url = `https://api.weatherapi.com/v1/forecast.json?key=${apiKey}&q=${lat},${lon}&days=1&aqi=no`;
  const data = await httpRequest(url, { method: 'GET', timeout: 10000 });
  const json = JSON.parse(data);
  if (json.error) throw new Error(`WeatherAPI: ${json.error.message}`);
  const c = json.current || {};
  const astro = json.forecast?.forecastday?.[0]?.astro || {};
  return {
    raw: `${c.condition?.text || 'Unknown'} +${c.temp_c}°C UV:${c.uv} (weatherapi)`,
    condition: c.condition?.text || 'Unknown',
    tempC: Math.round(c.temp_c || 20),
    precipMM: c.precip_mm || 0,
    uvIndex: Math.round(c.uv || 0),
    sunrise: astro.sunrise ? parse12hTo24h(astro.sunrise) : '',
    sunset: astro.sunset ? parse12hTo24h(astro.sunset) : '',
  };
}

async function fetchHourlyWeatherAPI(location: string, apiKey: string): Promise<HourlyEntry[]> {
  const { lat, lon } = await geocode(location);
  const url = `https://api.weatherapi.com/v1/forecast.json?key=${apiKey}&q=${lat},${lon}&days=1&aqi=no`;
  const data = await httpRequest(url, { method: 'GET', timeout: 10000 });
  const json = JSON.parse(data);
  if (json.error) throw new Error(`WeatherAPI: ${json.error.message}`);
  const hours = json.forecast?.forecastday?.[0]?.hour || [];
  return hours.filter((_: any, i: number) => i % 3 === 0).map((h: any) => ({
    hour: parseInt((h.time || '').slice(11, 13), 10),
    uvIndex: Math.round(h.uv || 0),
    tempC: Math.round(h.temp_c || 20),
    condition: h.condition?.text || 'Unknown',
  }));
}

function parse12hTo24h(timeStr: string): string {
  const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return timeStr.trim().slice(0, 5);
  let h = parseInt(match[1], 10);
  const m = match[2];
  const ampm = match[3].toUpperCase();
  if (ampm === 'PM' && h < 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${m}`;
}

/**
 * Get UV index for a specific hour from hourly data.
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
