import { ParsedWeather, estimateSolarGainPerHour, isDaylight } from './weather';
import { TankConfig, heatingRate } from './settings';
import { BoilerState, lastRun } from './state';

function getTimezoneDate(tz: string): Date {
  // Create a date in the configured timezone
  return new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
}

export function simulateWindow(
  startTemp: number, weather: ParsedWeather,
  fromMs: number, toMs: number, solar: boolean, tz: string,
): number {
  let temp = startTemp;
  const hoursSince = (toMs - fromMs) / (3600 * 1000);
  if (hoursSince <= 0) return temp;

  for (let h = 0; h < Math.floor(hoursSince); h++) {
    const checkMs = fromMs + (h + 1) * 3600 * 1000;
    const checkDate = new Date(checkMs);
    const localStr = checkDate.toLocaleString('en-US', { timeZone: tz, hour12: false });
    const hour = parseInt(localStr.split(',')[1]?.trim().split(':')[0] || '0', 10);
    const minuteOfDay = hour * 60 + parseInt(localStr.split(':')[1] || '0', 10);

    if (solar) {
      if (hour >= 20 || hour < 6) {
        temp -= 0.5; // night loss
      } else {
        temp -= 0.3; // day loss
      }
      if (isDaylight(minuteOfDay, weather)) {
        temp += estimateSolarGainPerHour(weather, checkDate.getMonth()) / 2.0;
      }
    } else {
      temp -= 0.4; // electric-only: consistent loss
    }
  }
  return temp;
}

export function clampTemp(temp: number, ambientTempC: number): number {
  let ambient = ambientTempC;
  if (ambient < 15) ambient = 15;
  if (temp < ambient) temp = ambient;
  if (temp > 70) temp = 70;
  return temp;
}

export function estimateTankTemp(
  state: BoilerState, weather: ParsedWeather,
  now: Date, tank: TankConfig, tz: string,
): number {
  const nowMs = now.getTime();
  const rate = heatingRate(tank);

  // If we have a recent stored estimate, use it
  if (state.lastEstimatedAt && state.lastEstimatedTemp >= 15 && state.lastEstimatedTemp <= 70) {
    const estimateMs = new Date(state.lastEstimatedAt).getTime();
    const hoursSince = (nowMs - estimateMs) / (3600 * 1000);

    if (hoursSince >= 0 && hoursSince < 24) {
      const last = lastRun(state);
      if (last && new Date(last.finishedAt).getTime() > estimateMs) {
        // Boiler ran after last estimate
        const startMs = new Date(last.startedAt).getTime();
        const finishMs = new Date(last.finishedAt).getTime();
        let temp = simulateWindow(state.lastEstimatedTemp, weather, estimateMs, startMs, tank.solar, tz);
        temp += last.durationMins * rate;
        if (temp > 70) temp = 70;
        temp = simulateWindow(temp, weather, finishMs, nowMs, tank.solar, tz);
        return clampTemp(temp, weather.tempC);
      }

      // No boiler run since last estimate
      const temp = simulateWindow(state.lastEstimatedTemp, weather, estimateMs, nowMs, tank.solar, tz);
      return clampTemp(temp, weather.tempC);
    }
  }

  // No recent estimate — fall back to full recalculation
  const last = lastRun(state);
  if (!last) {
    const month = now.getMonth() + 1;
    if (month >= 6 && month <= 8) return 45;
    if ((month >= 4 && month <= 5) || (month >= 9 && month <= 10)) return 35;
    return 25;
  }

  const finishMonth = new Date(last.finishedAt).getMonth() + 1;
  let baseTemp = 20;
  if (finishMonth >= 5 && finishMonth <= 9) baseTemp = 25;
  let postHeatTemp = baseTemp + last.durationMins * rate;
  if (postHeatTemp > 70) postHeatTemp = 70;

  const finishMs = new Date(last.finishedAt).getTime();
  const temp = simulateWindow(postHeatTemp, weather, finishMs, nowMs, tank.solar, tz);
  return clampTemp(temp, weather.tempC);
}
