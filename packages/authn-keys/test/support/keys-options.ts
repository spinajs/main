import { keysOptionsOf } from '../../src/options/index.js';
import type { KeysConfig, KeysOptions } from '../../src/options/index.js';

export const TEST_KEYS_CONFIG: KeysConfig = {
  algorithms: ['EdDSA', 'ES256'],
  challenge: { ttlSeconds: 120, audience: null },
  assertion: { typ: 'spinajs-client+jwt', audience: null, maxLifetimeSeconds: 300, skewSeconds: 30 },
  httpSignature: { maxAgeSeconds: 300, skewSeconds: 30, requiredComponents: ['@method', '@target-uri', 'content-digest'] },
};

export interface KeysOverrides {
  readonly algorithms?: KeysConfig['algorithms'];
  readonly challenge?: Partial<KeysConfig['challenge']>;
  readonly assertion?: Partial<KeysConfig['assertion']>;
  readonly httpSignature?: Partial<KeysConfig['httpSignature']>;
}

export const keysOptionsFor = (over: KeysOverrides = {}): KeysOptions =>
  keysOptionsOf({
    algorithms: over.algorithms ?? TEST_KEYS_CONFIG.algorithms,
    challenge: { ...TEST_KEYS_CONFIG.challenge, ...over.challenge },
    assertion: { ...TEST_KEYS_CONFIG.assertion, ...over.assertion },
    httpSignature: { ...TEST_KEYS_CONFIG.httpSignature, ...over.httpSignature },
  });
