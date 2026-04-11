import { Logger } from 'homebridge';
import * as https from 'https';
import * as http from 'http';

const AI_RETRY_COUNT = 2;
const AI_RETRY_DELAY_MS = 30000;

export function isRetryableError(err: Error): boolean {
  const msg = err.message;
  if (/API error (429|503|502|500)/.test(msg)) return true;
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|Request timeout/.test(msg)) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry<T>(
  fn: () => Promise<T>, retries: number, delayMs: number, log?: Logger,
): Promise<T> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err as Error;
      if (!isRetryableError(lastErr) || attempt === retries) break;
      log?.warn(`AI request failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delayMs / 1000}s: ${lastErr.message}`);
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

export async function callAI(
  prompt: string,
  timeoutSecs: number,
  xaiApiKey?: string,
  geminiApiKey?: string,
  temperature = 0.3,
  log?: Logger,
): Promise<string> {
  if (xaiApiKey) {
    return callOpenAICompatible(
      'https://api.x.ai/v1/chat/completions',
      xaiApiKey, 'grok-3-mini-fast', prompt, timeoutSecs, temperature, log,
    );
  }
  if (geminiApiKey) {
    return callGeminiREST(geminiApiKey, 'gemini-2.5-flash-lite', prompt, timeoutSecs, log);
  }
  throw new Error('No AI API key set (need geminiApiKey or xaiApiKey)');
}

function callOpenAICompatible(
  endpoint: string, apiKey: string, model: string,
  prompt: string, timeoutSecs: number, temperature: number, log?: Logger,
): Promise<string> {
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature,
  });

  return withRetry(() =>
    httpRequest(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      timeout: timeoutSecs * 1000,
    }, body),
  AI_RETRY_COUNT, AI_RETRY_DELAY_MS, log,
  ).then(data => {
    const result = JSON.parse(data);
    if (!result.choices?.length) throw new Error('Empty AI response');
    return result.choices[0].message.content;
  });
}

function callGeminiREST(
  apiKey: string, model: string, prompt: string, timeoutSecs: number, log?: Logger,
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
  });

  return withRetry(() =>
    httpRequest(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      timeout: timeoutSecs * 1000,
    }, body),
  AI_RETRY_COUNT, AI_RETRY_DELAY_MS, log,
  ).then(data => {
    const result = JSON.parse(data);
    if (!result.candidates?.[0]?.content?.parts?.[0]?.text) {
      throw new Error('Empty AI response');
    }
    return result.candidates[0].content.parts[0].text;
  });
}

function httpRequest(
  url: string,
  options: http.RequestOptions & { timeout?: number },
  body?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`API error ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    if (options.timeout) {
      req.setTimeout(options.timeout, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
    }
    if (body) req.write(body);
    req.end();
  });
}

export { httpRequest };
