import { loadConfig, type Config } from '../../src/config.js';

export const TEST_SEP10_SECRET = 'SB57C5N5BUG42RFOAX446RU4VWMGNLFDK4AIIP5WHB5U6L2XE5M3BUSQ';

export function testConfig(databaseUrl: string, overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: databaseUrl,
    STELLAR_NETWORK: 'testnet',
    STELLAR_RPC_URL: 'https://rpc.invalid',
    PUBLIC_URL: 'https://api.stellarsafe.test',
    JWT_SECRET: 'test-secret-test-secret-test-secret!',
    SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    SEP10_SIGNING_SECRET: TEST_SEP10_SECRET,
    NOTIFY_ALLOW_PRIVATE_TARGETS: 'true',
    ...overrides,
  });
}
