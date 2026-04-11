import { Logger } from 'homebridge';
import { BoilerPlugConfig } from './settings';
import { httpRequest } from './ai';

const WEBHOOK_RETRIES = 3;
const WEBHOOK_TIMEOUT = 5000;
const WEBHOOK_RETRY_DELAY = 2000;

export async function sendWebhook(on: boolean, plug: BoilerPlugConfig, log: Logger): Promise<void> {
  const url = on ? plug.onUrl : plug.offUrl;
  const method = (plug.method || 'GET').toUpperCase();

  let headers: Record<string, string> = {};
  if (plug.headers) {
    try {
      headers = JSON.parse(plug.headers);
    } catch {
      log.warn('WEBHOOK: failed to parse headers JSON');
    }
  }

  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= WEBHOOK_RETRIES; attempt++) {
    try {
      await httpRequest(url, {
        method,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        timeout: WEBHOOK_TIMEOUT,
      }, plug.body || undefined);

      log.info(`WEBHOOK: boiler ${on ? 'true' : 'false'} (attempt ${attempt})`);
      return;
    } catch (err) {
      lastErr = err as Error;
      log.warn(`WEBHOOK: attempt ${attempt} failed: ${lastErr.message}`);
      if (attempt < WEBHOOK_RETRIES) {
        await sleep(WEBHOOK_RETRY_DELAY);
      }
    }
  }

  throw new Error(`Webhook failed after ${WEBHOOK_RETRIES} attempts: ${lastErr?.message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
