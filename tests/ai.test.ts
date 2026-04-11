import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isRetryableError } from '../src/ai';

describe('isRetryableError', () => {
  it('returns true for 503', () => {
    expect(isRetryableError(new Error('API error 503: Service Unavailable'))).toBe(true);
  });

  it('returns true for 429', () => {
    expect(isRetryableError(new Error('API error 429: Too Many Requests'))).toBe(true);
  });

  it('returns true for 502', () => {
    expect(isRetryableError(new Error('API error 502: Bad Gateway'))).toBe(true);
  });

  it('returns true for 500', () => {
    expect(isRetryableError(new Error('API error 500: Internal Server Error'))).toBe(true);
  });

  it('returns true for ECONNRESET', () => {
    expect(isRetryableError(new Error('ECONNRESET'))).toBe(true);
  });

  it('returns true for ECONNREFUSED', () => {
    expect(isRetryableError(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe(true);
  });

  it('returns true for ETIMEDOUT', () => {
    expect(isRetryableError(new Error('connect ETIMEDOUT'))).toBe(true);
  });

  it('returns true for Request timeout', () => {
    expect(isRetryableError(new Error('Request timeout'))).toBe(true);
  });

  it('returns true for socket hang up', () => {
    expect(isRetryableError(new Error('socket hang up'))).toBe(true);
  });

  it('returns false for 400', () => {
    expect(isRetryableError(new Error('API error 400: Bad Request'))).toBe(false);
  });

  it('returns false for 401', () => {
    expect(isRetryableError(new Error('API error 401: Unauthorized'))).toBe(false);
  });

  it('returns false for Empty AI response', () => {
    expect(isRetryableError(new Error('Empty AI response'))).toBe(false);
  });

  it('returns false for No AI API key', () => {
    expect(isRetryableError(new Error('No AI API key set'))).toBe(false);
  });
});

describe('callAI', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('throws when no API key is provided', async () => {
    const { callAI } = await import('../src/ai');
    await expect(callAI('test prompt', 30)).rejects.toThrow('No AI API key set');
  });
});
