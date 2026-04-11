import { Logger } from 'homebridge';
import { SwitcherConfig } from './settings';

let SwitcherModule: any = null;
try {
  SwitcherModule = require('switcher-js2');
} catch {
  // Checked at runtime
}

// Cache the discovered device so we don't re-discover every time
let cachedDevice: any = null;
let cachedDeviceId: string | null = null;

function discoverDevice(config: SwitcherConfig, log: Logger): Promise<any> {
  return new Promise((resolve, reject) => {
    // Return cached device if same ID
    if (cachedDevice && cachedDeviceId === config.deviceId) {
      return resolve(cachedDevice);
    }

    const timeout = setTimeout(() => {
      reject(new Error(`Switcher device ${config.deviceId} not found on network (10s timeout). Make sure the device is on and reachable.`));
    }, 10000);

    // discover() listens for UDP broadcasts and returns a ready-to-use Switcher instance
    const proxy = SwitcherModule.discover(
      (msg: string) => log.debug(`SWITCHER: ${msg}`),
      config.deviceId, // identifier to match
      9000, // discovery timeout
    );

    proxy.on('ready', (device: any) => {
      clearTimeout(timeout);
      cachedDevice = device;
      cachedDeviceId = config.deviceId;
      log.info(`SWITCHER: discovered device ${config.deviceId} at ${config.deviceIp}`);
      resolve(device);
    });

    proxy.on('error', (err: Error) => {
      clearTimeout(timeout);
      reject(new Error(`Switcher discovery error: ${err.message}`));
    });
  });
}

export async function switcherTurnOn(config: SwitcherConfig, minutes: number, log: Logger): Promise<void> {
  if (!SwitcherModule) {
    throw new Error('switcher-js2 not installed');
  }

  const device = await discoverDevice(config, log);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Switcher turn_on timed out')), 10000);

    try {
      device.turn_on(minutes);
      setTimeout(() => {
        clearTimeout(timeout);
        log.info(`SWITCHER: turned ON for ${minutes} min`);
        resolve();
      }, 2000);
    } catch (err) {
      clearTimeout(timeout);
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
    const timeout = setTimeout(() => reject(new Error('Switcher turn_off timed out')), 10000);

    try {
      device.turn_off();
      setTimeout(() => {
        clearTimeout(timeout);
        log.info('SWITCHER: turned OFF');
        resolve();
      }, 2000);
    } catch (err) {
      clearTimeout(timeout);
      reject(err);
    }
  });
}
