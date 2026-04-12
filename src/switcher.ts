import { Logger } from 'homebridge';
import { SwitcherConfig } from './settings';
import * as client from './switcherClient';

// Cache with TTL (#7)
let cachedDevice: client.DiscoveredDevice | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function invalidateCache(): void {
  cachedDevice = null;
  cacheTimestamp = 0;
}

async function resolveDevice(config: SwitcherConfig, log: Logger): Promise<client.DiscoveredDevice> {
  // Return cached device if not expired
  if (cachedDevice && (Date.now() - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedDevice;
  }

  invalidateCache();
  log.debug('SWITCHER: discovering device...');
  const device = await client.discover(config.deviceId, 10000);

  // Override IP if configured
  if (config.deviceIp) {
    device.ip = config.deviceIp;
  }

  cachedDevice = device;
  cacheTimestamp = Date.now();
  log.info(`SWITCHER: discovered ${device.name} (${device.deviceId}) at ${device.ip}`);
  return device;
}

/**
 * Fresh discovery to get current device state (bypasses cache).
 */
async function checkDeviceState(config: SwitcherConfig, log: Logger): Promise<client.DiscoveredDevice> {
  log.debug('SWITCHER: checking device state...');
  const device = await client.discover(config.deviceId, 10000);
  if (config.deviceIp) {
    device.ip = config.deviceIp;
  }
  // Update cache with fresh data
  cachedDevice = device;
  cacheTimestamp = Date.now();
  return device;
}

export async function switcherTurnOn(config: SwitcherConfig, minutes: number, log: Logger): Promise<void> {
  try {
    // Fresh state check — skip if already on (manual intervention)
    const device = await checkDeviceState(config, log);
    if (device.state === 'on') {
      log.info(`SWITCHER: device is already ON — skipping (manual or external control detected)`);
      return;
    }

    await client.switcherTurnOn(device.deviceId, device.ip, device.deviceKey, minutes);
    log.info(`SWITCHER: turned ON for ${minutes} min`);
  } catch (err) {
    invalidateCache();
    throw err;
  }
}

export async function switcherTurnOff(config: SwitcherConfig, log: Logger): Promise<void> {
  try {
    const device = await resolveDevice(config, log);
    await client.switcherTurnOff(device.deviceId, device.ip, device.deviceKey);
    log.info('SWITCHER: turned OFF');
  } catch (err) {
    invalidateCache();
    throw err;
  }
}
