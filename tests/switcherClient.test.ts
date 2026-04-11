import { describe, it, expect } from 'vitest';
import { decryptToken } from '../src/switcherClient';

describe('switcherClient', () => {
  describe('decryptToken', () => {
    it('decrypts a valid base64 token to hex', () => {
      // The decryption should produce a hex string without throwing
      const token = 'zRS+bQt6WafQs2q62RvwaQ==';
      const result = decryptToken(token);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
      // Should be valid hex
      expect(/^[0-9a-f]+$/.test(result)).toBe(true);
    });

    it('throws on invalid token', () => {
      expect(() => decryptToken('not-valid-base64!!!')).toThrow();
    });
  });
});
