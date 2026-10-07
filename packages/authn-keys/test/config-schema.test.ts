import 'mocha';
import { expect } from 'chai';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn/schemas';
import { MemorySecretStore, FakeBackoffThrottle, throttleParams } from '@spinajs/authn-testing';

import { keysOptionsOf } from '../src/options/index.js';
import type { KeysConfig } from '../src/options/index.js';
import { MemoryKeyNonceStore } from '../src/nonce/index.js';
import { DefaultKeyRegistry, MemoryKeyStore } from '../src/registry/index.js';
import { HttpSignatureStrategy, JwsAssertionStrategy, KeyChallengeStrategy } from '../src/strategies/index.js';
import { StrictJwsVerifier } from '../src/jws/index.js';
import { boot, disposeBooted, readingFrom, violationsOf } from './support/config-boot.js';
import { TEST_KEYS_CONFIG, keysOptionsFor } from './support/keys-options.js';
import type { KeysOverrides } from './support/keys-options.js';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA];
const bad = (keys: Record<string, unknown>) => violationsOf(SCHEMAS, { authn: { keys } });
const AUD = 'https://keys.example.test';

async function parts(keys: Record<string, unknown>) {
  const { child, configuration } = await boot(SCHEMAS, { authn: { keys } });
  const registry = readingFrom(new DefaultKeyRegistry(new MemoryKeyStore(), new MemorySecretStore(), new FakeBackoffThrottle(throttleParams()), []), child);
  return { child, configuration, registry };
}

describe('authn.keys through the schema', () => {
  afterEach(disposeBooted);

  describe('defaults', () => {
    it('fills the whole block, equal to the test fixture', async () => {
      const { configuration } = await boot(SCHEMAS, {});
      expect(configuration.get('authn.keys')).to.deep.eq({ ...TEST_KEYS_CONFIG });
    });

    it('keeps a configured value and fills the rest of its block', async () => {
      const { configuration } = await boot(SCHEMAS, { authn: { keys: { assertion: { audience: AUD, skewSeconds: 10 } } } });
      expect(configuration.get('authn.keys.assertion')).to.deep.eq({ ...TEST_KEYS_CONFIG.assertion, audience: AUD, skewSeconds: 10 });
      expect(configuration.get('authn.keys.httpSignature.skewSeconds')).to.eq(30);
    });
  });

  describe('violations', () => {
    it('names the bad key', async function () {
      this.timeout(30000);
      const cases: [Record<string, unknown>, string][] = [
        [{ algorithms: [] }, 'authn.keys.algorithms'],
        [{ algorithms: ['RS256'] }, 'authn.keys.algorithms.0'],
        [{ algorithms: ['EdDSA', 'EdDSA'] }, 'authn.keys.algorithms'],
        [{ challenge: { ttlSeconds: 0 } }, 'authn.keys.challenge.ttlSeconds'],
        [{ challenge: { ttlSeconds: 3601 } }, 'authn.keys.challenge.ttlSeconds'],
        [{ challenge: { audience: {} } }, 'authn.keys.challenge.audience'],
        [{ assertion: { typ: '' } }, 'authn.keys.assertion.typ'],
        [{ assertion: { maxLifetimeSeconds: 301 } }, 'authn.keys.assertion.maxLifetimeSeconds'],
        [{ assertion: { maxLifetimeSeconds: 0 } }, 'authn.keys.assertion.maxLifetimeSeconds'],
        [{ assertion: { skewSeconds: 301 } }, 'authn.keys.assertion.skewSeconds'],
        [{ assertion: { skewSeconds: -1 } }, 'authn.keys.assertion.skewSeconds'],
        [{ httpSignature: { maxAgeSeconds: 301 } }, 'authn.keys.httpSignature.maxAgeSeconds'],
        [{ httpSignature: { skewSeconds: 301 } }, 'authn.keys.httpSignature.skewSeconds'],
        [{ httpSignature: { requiredComponents: ['@method', ''] } }, 'authn.keys.httpSignature.requiredComponents.1'],
      ];
      for (const [keys, path] of cases) expect(await bad(keys), JSON.stringify(keys)).to.include(path);
    });

    it('accepts the limits', async () => {
      expect(await bad({ challenge: { ttlSeconds: 3600 }, assertion: { maxLifetimeSeconds: 300, skewSeconds: 300 }, httpSignature: { maxAgeSeconds: 1, skewSeconds: 0 } })).to.deep.eq([]);
    });
  });

  describe('keysOptionsOf', () => {
    it('falls back to the assertion audience for challenges, and keeps an explicit challenge audience', () => {
      const withAssertion: KeysConfig = { ...TEST_KEYS_CONFIG, assertion: { ...TEST_KEYS_CONFIG.assertion, audience: AUD } };
      expect(keysOptionsOf(withAssertion).challenge.audience).to.eq(AUD);
      expect(keysOptionsOf({ ...withAssertion, challenge: { ttlSeconds: 120, audience: 'other' } }).challenge.audience).to.eq('other');
      expect(keysOptionsOf(TEST_KEYS_CONFIG).challenge.audience).to.eq(null);
    });

    it('refuses a range the schema refuses, for a config or Options that never went through it', () => {
      const cases: KeysOverrides[] = [
        { challenge: { ttlSeconds: 0 } },
        { challenge: { ttlSeconds: 3601 } },
        { challenge: { ttlSeconds: Number.NaN } },
        { assertion: { maxLifetimeSeconds: 0 } },
        { assertion: { maxLifetimeSeconds: 301 } },
        { assertion: { maxLifetimeSeconds: '60' as unknown as number } },
        { assertion: { skewSeconds: -1 } },
        { assertion: { skewSeconds: 301 } },
        { assertion: { skewSeconds: undefined as unknown as number } },
        { httpSignature: { maxAgeSeconds: Infinity } },
        { httpSignature: { maxAgeSeconds: 0 } },
        { httpSignature: { skewSeconds: 1.5 } },
      ];
      for (const over of cases) {
        const [block, values] = Object.entries(over)[0] as [string, Record<string, unknown>];
        const key = Object.keys(values)[0];
        expect(() => keysOptionsFor(over), JSON.stringify(over)).to.throw(`authn.keys.${block}.${key}`);
      }
      expect(() => keysOptionsFor({ challenge: { ttlSeconds: 3600 }, assertion: { maxLifetimeSeconds: 1, skewSeconds: 0 }, httpSignature: { maxAgeSeconds: 300, skewSeconds: 300 } })).to.not.throw();
    });

    it('freezes the result and returns the same object for the same config', () => {
      const options = keysOptionsOf(TEST_KEYS_CONFIG);
      expect(Object.isFrozen(options) && Object.isFrozen(options.assertion) && Object.isFrozen(options.httpSignature.requiredComponents)).to.eq(true);
      expect(keysOptionsOf(TEST_KEYS_CONFIG)).to.eq(options);
    });
  });

  describe('through @Config', () => {
    it('DefaultKeyRegistry reads authn.keys from its container and refuses a challenge without an audience', async () => {
      const without = await parts({});
      let error: unknown;
      try {
        await without.registry.challenge({ purpose: 'login', kid: 'k' }, { now: new Date(), purpose: 'login' });
      } catch (e) {
        error = e;
      }
      expect(String(error)).to.contain('authn.keys.challenge.audience');
      const configured = await parts({ assertion: { audience: AUD } });
      const challenge = await configured.registry.challenge({ purpose: 'login', kid: 'k' }, { now: new Date(), purpose: 'login' });
      expect(challenge).to.be.an('object');
    });

    it('JwsAssertionStrategy and KeyChallengeStrategy fail their boot without an audience', async () => {
      const { child, registry } = await parts({});
      const assertion = readingFrom(new JwsAssertionStrategy(registry, new StrictJwsVerifier(), new MemoryKeyNonceStore()), child);
      let error: unknown;
      try {
        await assertion.resolve();
      } catch (e) {
        error = e;
      }
      expect(String(error)).to.contain('authn.keys.assertion.audience');
      const challenge = readingFrom(new KeyChallengeStrategy(registry, new MemorySecretStore()), child);
      error = undefined;
      try {
        await challenge.resolve();
      } catch (e) {
        error = e;
      }
      expect(String(error)).to.contain('authn.keys.challenge.audience');
    });

    it('the strategies boot with an audience, and HttpSignatureStrategy needs none', async () => {
      const { child, registry } = await parts({ assertion: { audience: AUD } });
      await readingFrom(new JwsAssertionStrategy(registry, new StrictJwsVerifier(), new MemoryKeyNonceStore()), child).resolve();
      await readingFrom(new KeyChallengeStrategy(registry, new MemorySecretStore()), child).resolve();
      await readingFrom(new HttpSignatureStrategy(registry, new MemoryKeyNonceStore()), child).resolve();
    });
  });
});
