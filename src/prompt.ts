import { BoilerAIConfig, heatingRate } from './settings';
import { ParsedWeather } from './weather';
import { BoilerState, lastRun } from './state';

// Sanitize external strings before embedding in AI prompt (#10)
function sanitize(s: string): string {
  return s.replace(/[\n\r|]/g, ' ').trim();
}

export function buildPrompt(
  now: Date, weather: ParsedWeather, tankTemp: number,
  solarGain: number, state: BoilerState, config: BoilerAIConfig, tz: string,
): string {
  const lines: string[] = [];
  const rate = heatingRate(config.tank);

  // System description
  if (config.tank.solar) {
    lines.push(`You are the controller for a rooftop solar hot water tank (${config.tank.liters}L) with ${config.tank.heaterKw}kW electric backup in ${config.location}.`);
    lines.push('This is a solar boiler — the tank sits on the roof exposed to direct sun.');
    lines.push('On sunny days the sun heats the water significantly without any electric heating.');
    lines.push(`Heating rate (electric): ~${rate.toFixed(1)}°C/min. Standby loss: ~0.5°C/hour (night), ~0.3°C/hour (day).`);
  } else {
    lines.push(`You are the controller for an electric hot water tank (${config.tank.liters}L) with ${config.tank.heaterKw}kW heater in ${config.location}.`);
    lines.push('This is an electric-only tank with no solar heating.');
    lines.push(`Heating rate: ~${rate.toFixed(1)}°C/min. Standby loss: ~0.4°C/hour.`);
  }
  lines.push('');

  // Current status
  const timeStr = now.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  const dayStr = now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' });
  lines.push('=== CURRENT STATUS ===');
  lines.push(`Time: ${timeStr} (${dayStr})`);
  if (config.tank.solar) {
    lines.push(`Sunrise: ${weather.sunrise} | Sunset: ${weather.sunset}`);
  }

  // Weather
  lines.push('');
  lines.push('=== WEATHER ===');
  lines.push(`Condition: ${sanitize(weather.condition)}`);
  lines.push(`Temperature: ${Math.round(weather.tempC)}°C`);
  if (config.tank.solar) {
    lines.push(`UV Index: ${weather.uvIndex}`);
  }
  lines.push(`Precipitation: ${weather.precipMM.toFixed(1)}mm`);
  if (config.tank.solar) {
    lines.push(`Solar gain estimate: ${solarGain.toFixed(1)}°C/hour`);
  }

  // Tank estimate
  lines.push('');
  lines.push('=== TANK ESTIMATE ===');
  lines.push(`Estimated current tank temperature: ${Math.round(tankTemp)}°C`);
  const last = lastRun(state);
  if (last) {
    const hoursAgo = (now.getTime() - new Date(last.finishedAt).getTime()) / 3600000;
    lines.push(`Last heating: ${hoursAgo.toFixed(1)} hours ago, ran ${last.durationMins} minutes`);
  } else {
    lines.push('Last heating: unknown (no history)');
  }

  // Schedule
  lines.push('');
  lines.push('=== HOT WATER SCHEDULE ===');
  const nowMins = now.getHours() * 60 + now.getMinutes();
  for (const goal of config.usage) {
    const [gh, gm] = goal.time.split(':').map(Number);
    const goalMins = gh * 60 + gm;
    const diff = goalMins - nowMins;
    let status = '';
    if (diff > 0 && diff <= 240) {
      status = ` ← in ${Math.floor(diff / 60)}h${String(diff % 60).padStart(2, '0')}m`;
    } else if (diff >= -30 && diff <= 0) {
      status = ' ← NOW';
    }
    lines.push(`- ${goal.time} ${goal.label} (needs ~${Math.round(goal.temp)}°C, ~${goal.liters}L)${status}`);
  }

  // Heating estimates
  lines.push('');
  lines.push('=== HEATING ESTIMATES ===');
  for (const goal of config.usage) {
    const [gh, gm] = goal.time.split(':').map(Number);
    const goalMins = gh * 60 + gm;
    if (goalMins <= nowMins) continue;
    const needed = goal.temp - tankTemp;
    if (needed <= 0) {
      lines.push(`- ${goal.time} ${goal.label}: tank already at target (${Math.round(tankTemp)}°C >= ${Math.round(goal.temp)}°C)`);
    } else {
      const minsNeeded = Math.ceil(needed / rate);
      const startBy = goalMins - minsNeeded;
      lines.push(`- ${goal.time} ${goal.label}: need +${Math.round(needed)}°C = ~${minsNeeded} minutes heating. Start by ${String(Math.floor(startBy / 60)).padStart(2, '0')}:${String(startBy % 60).padStart(2, '0')}.`);
    }
  }

  // Recent history
  lines.push('');
  lines.push('=== RECENT HISTORY ===');
  const hist = state.history.slice(-5).reverse();
  if (hist.length === 0) {
    lines.push('No previous runs recorded.');
  }
  for (const r of hist) {
    const d = new Date(r.finishedAt);
    const dStr = d.toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric' });
    const tStr = d.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
    lines.push(`- ${dStr} ${tStr}: ${r.durationMins} min, ${r.condition} ${Math.round(r.tempC)}°C, trigger: ${r.trigger}`);
  }

  // Decision instruction
  lines.push('');
  lines.push('=== YOUR DECISION ===');
  lines.push('Should the boiler turn on NOW? If yes, for how many minutes?');
  lines.push('Consider: time until next goal, current estimated temp, solar gain remaining today,');
  lines.push('and whether heating now vs. later is more efficient.');
  lines.push('');
  lines.push('IMPORTANT: Your response MUST start with a NUMBER followed by a pipe character.');
  lines.push('Examples of correct responses:');
  lines.push('  45|Need to heat for bath, tank too cold.');
  lines.push('  0|Tank already at target, no heating needed.');
  lines.push(`The number is the heating duration in minutes (0-${config.maxDurationMinutes}). Everything after | is your reasoning.`);
  lines.push('Do NOT write the word REPORT. Just the number, pipe, then your reasoning.');

  return lines.join('\n');
}

export function parseAIResponse(raw: string, maxMinutes: number): { minutes: number; report: string } {
  const cleaned = raw.trim().replace(/^```/, '').replace(/```$/, '').trim();

  for (const line of cleaned.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('|');
    if (parts.length < 2) continue;
    const numStr = parts[0].trim();
    if (numStr.length === 0 || numStr.length > 3) continue;
    const minutes = parseInt(numStr, 10);
    if (isNaN(minutes)) continue;
    if (minutes >= 0 && minutes <= maxMinutes) {
      const report = parts.slice(1).join('|').trim();
      if (report.toUpperCase() === 'REPORT') continue;
      return { minutes, report };
    }
  }

  throw new Error('No valid MINUTES|REPORT line found in AI response');
}
