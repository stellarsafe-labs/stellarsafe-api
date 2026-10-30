import { describe, expect, it } from 'vitest';
import { assertWebhookUrl, isPublicAddress } from '../../src/modules/notifications/ssrf.js';

describe('isPublicAddress', () => {
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('allows public %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '172.16.3.4',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1',
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
});

describe('assertWebhookUrl', () => {
  const strict = { allowPrivate: false, requireHttps: true };

  it('accepts public https URLs', () => {
    expect(assertWebhookUrl('https://hooks.example.com/x', strict).hostname).toBe('hooks.example.com');
  });

  it.each([
    ['http://hooks.example.com', 'https'],
    ['ftp://hooks.example.com', 'https'],
    ['https://user:pass@hooks.example.com', 'credentials'],
    ['https://127.0.0.1/hook', 'private'],
    ['https://[::1]/hook', 'private'],
    ['https://169.254.169.254/latest/meta-data', 'private'],
    ['https://localhost/hook', 'private'],
    ['https://db.internal/hook', 'private'],
    ['not a url', 'valid URL'],
  ])('rejects %s', (url, message) => {
    expect(() => assertWebhookUrl(url, strict)).toThrow(message);
  });

  it('allows http and private targets when the policy permits (dev only)', () => {
    expect(() =>
      assertWebhookUrl('http://127.0.0.1:9999', { allowPrivate: true, requireHttps: false }),
    ).not.toThrow();
  });
});
