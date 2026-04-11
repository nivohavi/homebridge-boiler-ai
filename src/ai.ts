import { Logger } from 'homebridge';
import * as https from 'https';
import * as http from 'http';

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
      xaiApiKey, 'grok-3-mini-fast', prompt, timeoutSecs, temperature,
    );
  }
  if (geminiApiKey) {
    return callGeminiREST(geminiApiKey, 'gemini-2.5-flash-lite', prompt, timeoutSecs);
  }
  throw new Error('No AI API key set (need geminiApiKey or xaiApiKey)');
}

function callOpenAICompatible(
  endpoint: string, apiKey: string, model: string,
  prompt: string, timeoutSecs: number, temperature: number,
): Promise<string> {
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature,
  });

  return httpRequest(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    timeout: timeoutSecs * 1000,
  }, body).then(data => {
    const result = JSON.parse(data);
    if (!result.choices?.length) throw new Error('Empty AI response');
    return result.choices[0].message.content;
  });
}

function callGeminiREST(
  apiKey: string, model: string, prompt: string, timeoutSecs: number,
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
  });

  return httpRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutSecs * 1000,
  }, body).then(data => {
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
