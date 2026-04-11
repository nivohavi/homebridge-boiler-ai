import { Logger } from 'homebridge';
import { SwitcherConfig } from './settings';

// switcher-js2 doesn't have TypeScript types, so we use require
let SwitcherModule: any = null;
try {
  SwitcherModule = require('switcher-js2');
} catch {
  // Will be checked at runtime when needed
}

export function isSwitcherAvailable(): boolean {
  return SwitcherModule !== null;
}

export async function switcherTurnOn(config: SwitcherConfig, minutes: number, log: Logger): Promise<void> {
  if (!SwitcherModule) {
    throw new Error('switcher-js2 not installed — run: npm install switcher-js2');
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Switcher turn_on timed out after 10s'));
    }, 10000);

    const switcher = new SwitcherModule(
      config.deviceId,
      config.deviceIp,
      (msg: string) => log.debug(`SWITCHER: ${msg}`),
      false, // don't listen for broadcasts
      config.deviceType || 'wasserkraft',
    );

    switcher.turn_on(minutes);

    // switcher-js2 turn_on doesn't have a callback, give it a moment
    setTimeout(() => {
      clearTimeout(timeout);
      log.info(`SWITCHER: turned ON for ${minutes} min`);
      resolve();
    }, 2000);
  });
}

export async function switcherTurnOff(config: SwitcherConfig, log: Logger): Promise<void> {
  if (!SwitcherModule) {
    throw new Error('switcher-js2 not installed — run: npm install switcher-js2');
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Switcher turn_off timed out after 10s'));
    }, 10000);

    const switcher = new SwitcherModule(
      config.deviceId,
      config.deviceIp,
      (msg: string) => log.debug(`SWITCHER: ${msg}`),
      false,
      config.deviceType || 'wasserkraft',
    );

    switcher.turn_off();

    setTimeout(() => {
      clearTimeout(timeout);
      log.info('SWITCHER: turned OFF');
      resolve();
    }, 2000);
  });
}
