import { Logger } from 'homebridge';
import { SwitcherConfig } from './settings';

let SwitcherModule: any = null;
try {
  SwitcherModule = require('switcher-js2');
} catch {
  // Checked at runtime
}

// Cache with TTL (#7)
let cachedDevice: any = null;
let cachedDeviceId: string | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function invalidateCache(): void {
  cachedDevice = null;
  cachedDeviceId = null;
  cacheTimestamp = 0;
}

function discoverDevice(config: SwitcherConfig, log: Logger): Promise<any> {
  return new Promise((resolve, reject) => {
    // Return cached device if same ID and not expired
    if (cachedDevice && cachedDeviceId === config.deviceId
        && (Date.now() - cacheTimestamp) < CACHE_TTL_MS) {
      return resolve(cachedDevice);
    }

    // Invalidate stale cache
    invalidateCache();

    let settled = false;

    // Catch uncaught exceptions from switcher-js2 internals (e.g. token decryption failures)
    const uncaughtHandler = (err: Error) => {
      if (err.message?.includes('wrong final block length') || err.message?.includes('Decipheriv')) {
        log.error(`SWITCHER: crypto error during discovery — ${err.message}`);
        invalidateCache();
        settle(() => reject(new Error(`Switcher crypto error: ${err.message}`)));
      }
    };
    process.on('uncaughtException', uncaughtHandler);
    const cleanup = () => process.removeListener('uncaughtException', uncaughtHandler);

    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        cleanup();
        fn();
      }
    };

    const timeout = setTimeout(() => {
      settle(() => reject(new Error(`Switcher device ${config.deviceId} not found on network (10s timeout). Make sure the device is on and reachable.`)));
    }, 10000);

    const proxy = SwitcherModule.discover(
      (msg: string) => log.debug(`SWITCHER: ${msg}`),
      config.deviceId,
      9000,
    );

    proxy.on('ready', (device: any) => {
      try {
        if (config.token && device.token === undefined) {
          device.token = config.token;
        }
        cachedDevice = device;
        cachedDeviceId = config.deviceId;
        cacheTimestamp = Date.now();
        log.info(`SWITCHER: discovered device ${config.deviceId}`);
        settle(() => resolve(device));
      } catch (err: any) {
        invalidateCache();
        settle(() => reject(new Error(`Switcher device init error: ${err.message}`)));
      }
    });

    proxy.on('error', (err: Error) => {
      invalidateCache();
      settle(() => reject(new Error(`Switcher discovery error: ${err.message}`)));
    });
  });
}

export async function switcherTurnOn(config: SwitcherConfig, minutes: number, log: Logger): Promise<void> {
  if (!SwitcherModule) {
    throw new Error('switcher-js2 not installed');
  }

  const device = await discoverDevice(config, log);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      invalidateCache(); // Force re-discovery on next attempt
      reject(new Error('Switcher turn_on timed out'));
    }, 10000);

    // Listen for errors (#8)
    const errorHandler = (err: Error) => {
      clearTimeout(timeout);
      invalidateCache();
      reject(new Error(`Switcher turn_on error: ${err.message}`));
    };
    device.once('error', errorHandler);

    try {
      device.turn_on(minutes);
      setTimeout(() => {
        clearTimeout(timeout);
        device.removeListener('error', errorHandler);
        log.info(`SWITCHER: turned ON for ${minutes} min`);
        resolve();
      }, 2000);
    } catch (err) {
      clearTimeout(timeout);
      device.removeListener('error', errorHandler);
      invalidateCache();
      reject(err);
    }
  });
}

export async function switcherTurnOff(config: SwitcherConfig, log: Logger): Promise<void> {
  if (!SwitcherModule) {
    throw new Error('switcher-js2 not installed');
  }

  const device = await discoverDevice(config, log);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      invalidateCache();
      reject(new Error('Switcher turn_off timed out'));
    }, 10000);

    const errorHandler = (err: Error) => {
      clearTimeout(timeout);
      invalidateCache();
      reject(new Error(`Switcher turn_off error: ${err.message}`));
    };
    device.once('error', errorHandler);

    try {
      device.turn_off();
      setTimeout(() => {
        clearTimeout(timeout);
        device.removeListener('error', errorHandler);
        log.info('SWITCHER: turned OFF');
        resolve();
      }, 2000);
    } catch (err) {
      clearTimeout(timeout);
      device.removeListener('error', errorHandler);
      invalidateCache();
      reject(err);
    }
  });
}
