import 'mocha';
import { expect } from 'chai';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn';

import authnLocal from '../src/config/authn-local.js';
import { Argon2PasswordHasher } from '../src/hasher.js';
import { LocalPasswordPolicy } from '../src/policy.js';
import { LocalPasswordService } from '../src/service.js';
import { PasswordExpirationJob } from '../src/expiration.js';
import { boot, disposeBooted, readingFrom, violationsOf } from './support/config-boot.js';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA];
// authn.local has no schema default of its own: an app that installs authn-local names it.
const LOCAL = { authn: { local: {} } };
const bad = (local: Record<string, unknown>) => violationsOf(SCHEMAS, { authn: { local } });

describe('authn.local through the schema', function () {
  this.timeout(30000);
  afterEach(disposeBooted);

  describe('defaults', () => {
    it('fills no authn.local tree for an app that does not name it', async () => {
      const { configuration } = await boot(SCHEMAS, {});
      expect(configuration.get('authn.local')).to.eq(undefined);
    });

    it('fills every key the classes used to default in code', async () => {
      const { configuration } = await boot(SCHEMAS, LOCAL);
      expect(configuration.get('authn.local.hasher.maxConcurrent')).to.eq(8);
      expect(configuration.get('authn.local.pepper')).to.deep.eq({ secret: null, version: 1 });
      expect(configuration.get('authn.local.policy')).to.deep.eq({ minLength: 8, maxLength: 128, rule: null, blocklist: null });
      expect(configuration.get('authn.local.generator.length')).to.eq(16);
      expect(configuration.get('authn.local.generator.characters')).to.have.length(3);
      expect(configuration.get('authn.local.reset')).to.deep.eq({ ttlSeconds: 3600, url: '', revokeTokens: true });
      expect(configuration.get('authn.local.invite.ttlSeconds')).to.eq(900);
      expect(configuration.get('authn.local.expiration')).to.deep.eq({ enabled: false, maxAgeDays: 31 });
    });

    it('keeps the shipped package config equal to the schema defaults it repeats', async () => {
      const { configuration } = await boot(SCHEMAS, LOCAL);
      const shipped = authnLocal.authn.local;
      expect(configuration.get('authn.local.hasher.maxConcurrent')).to.eq(shipped.hasher.maxConcurrent);
      expect(configuration.get('authn.local.pepper.version')).to.eq(shipped.pepper.version);
      expect(configuration.get('authn.local.policy.minLength')).to.eq(shipped.policy.minLength);
      expect(configuration.get('authn.local.policy.maxLength')).to.eq(shipped.policy.maxLength);
      expect(configuration.get('authn.local.reset.revokeTokens')).to.eq(shipped.reset.revokeTokens);
    });

    it('fills a partial generator and keeps a configured value', async () => {
      const { configuration } = await boot(SCHEMAS, { authn: { local: { generator: { length: 20 } } } });
      expect(configuration.get('authn.local.generator.length')).to.eq(20);
      expect(configuration.get('authn.local.generator.characters')).to.have.length(3);
    });
  });

  describe('violations', () => {
    it('names the bad key', async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ hasher: { maxConcurrent: 0 } }, 'authn.local.hasher.maxConcurrent'],
        [{ hasher: { maxConcurrent: 1.5 } }, 'authn.local.hasher.maxConcurrent'],
        [{ hasher: { cost: 4 } }, 'authn.local.hasher.cost'],
        [{ pepper: { secret: 'x', version: 0 } }, 'authn.local.pepper.version'],
        [{ pepper: { secret: 'x', version: 1_000_000_000 } }, 'authn.local.pepper.version'],
        [{ pepper: { secret: 'x', version: 1, previous: [{ secret: 'y', version: 1_000_000_000 }] } }, 'authn.local.pepper.previous.0.version'],
        [{ pepper: { secret: 'x', version: 3, previous: [{ secret: 'y', version: 1 }, { secret: 'z', version: 1 }] } }, 'authn.local.pepper.previous'],
        [{ pepper: { secret: 'x', previous: [{ secret: '', version: 1 }] } }, 'authn.local.pepper.previous.0.secret'],
        [{ policy: { minLength: 7 } }, 'authn.local.policy.minLength'],
        [{ policy: { minLength: 129 } }, 'authn.local.policy.minLength'],
        [{ policy: { maxLength: 129 } }, 'authn.local.policy.maxLength'],
        [{ policy: { minLength: 20, maxLength: 10 } }, 'authn.local.policy.maxLength'],
        [{ policy: { rule: 'a-string' } }, 'authn.local.policy.rule'],
        [{ generator: { length: 0 } }, 'authn.local.generator.length'],
        [{ generator: { characters: [] } }, 'authn.local.generator.characters'],
        [{ reset: { ttlSeconds: 0 } }, 'authn.local.reset.ttlSeconds'],
        [{ invite: { ttlSeconds: 0 } }, 'authn.local.invite.ttlSeconds'],
        [{ expiration: { maxAgeDays: 0 } }, 'authn.local.expiration.maxAgeDays'],
        [{ expiration: { maxAgeDays: -3 } }, 'authn.local.expiration.maxAgeDays'],
      ];
      for (const [local, path] of cases) expect(await bad(local), JSON.stringify(local)).to.include(path);
    });

    it('accepts equal bounds, a fractional expiry and a rotation', async () => {
      expect(await bad({ policy: { minLength: 12, maxLength: 12 } })).to.deep.eq([]);
      expect(await bad({ expiration: { enabled: true, maxAgeDays: 0.5 } })).to.deep.eq([]);
      expect(await bad({ pepper: { secret: 'x', version: 2, previous: [{ secret: 'y', version: 1 }] } })).to.deep.eq([]);
    });
  });

  describe('through @Config', () => {
    it('LocalPasswordPolicy reads its bounds and rule from the booted configuration', async () => {
      const { child } = await boot(SCHEMAS, { authn: { local: { policy: { minLength: 10, maxLength: 20, rule: { type: 'string', pattern: '[0-9]' }, description: 'needs a digit' } } } });
      const policy = readingFrom(new LocalPasswordPolicy(), child);
      policy.resolve();
      expect(policy.policy()).to.deep.include({ minLength: 10, maxLength: 20, pattern: '[0-9]', description: 'needs a digit' });
      expect(await policy.check('abcdefghij')).to.deep.eq(['rule']);
      expect(await policy.check('abcdefghi1')).to.deep.eq([]);
    });

    it('LocalPasswordPolicy still refuses a rule that does not compile and a blocklist that is not registered', async () => {
      const compile = await boot(SCHEMAS, { authn: { local: { policy: { rule: { type: 'no-such-type' } } } } });
      expect(() => readingFrom(new LocalPasswordPolicy(), compile.child).resolve()).to.throw(/does not compile/);
      const blocklist = await boot(SCHEMAS, { authn: { local: { policy: { blocklist: 'NoSuchBlocklist' } } } });
      expect(() => readingFrom(new LocalPasswordPolicy(), blocklist.child).resolve()).to.throw(/not registered as a PasswordBlocklist/);
    });

    it('LocalPasswordPolicy generates within the policy bounds and refuses a generator outside them', async () => {
      const ok = await boot(SCHEMAS, LOCAL);
      expect(readingFrom(new LocalPasswordPolicy(), ok.child).generate()).to.have.length(16);
      const outside = await boot(SCHEMAS, { authn: { local: { policy: { minLength: 20 }, generator: { length: 16 } } } });
      expect(() => readingFrom(new LocalPasswordPolicy(), outside.child).generate()).to.throw(/outside authn.local.policy bounds/);
    });

    it('the schema refuses a previous pepper that reuses the current version', async () => {
      expect(await bad({ pepper: { secret: 'current', version: 2, previous: [{ secret: 'old', version: 2 }] } })).to.include('authn.local.pepper.previous.0.version');
    });

    it('Argon2PasswordHasher hashes under the configured pepper and verifies a hash made under a previous one', async () => {
      const old = await boot(SCHEMAS, { authn: { local: { pepper: { secret: 'old-pepper', version: 1 } } } });
      const oldHasher = readingFrom(new Argon2PasswordHasher(), old.child);
      await oldHasher.resolve();
      const stored = await oldHasher.hash('correct horse battery');
      expect(stored.startsWith('$sp1$')).to.eq(true);

      const rotated = await boot(SCHEMAS, { authn: { local: { pepper: { secret: 'new-pepper', version: 2, previous: [{ secret: 'old-pepper', version: 1 }] } } } });
      const hasher = readingFrom(new Argon2PasswordHasher(), rotated.child);
      await hasher.resolve();
      expect(await hasher.verify(stored, 'correct horse battery')).to.eq(true);
      expect(hasher.needsRehash(stored)).to.eq(true);
    });

    it('LocalPasswordService revokes tokens unless authn.local.reset.revokeTokens is exactly false', async () => {
      class Probe extends LocalPasswordService {
        public revoked = 0;
        protected async tokens(): Promise<never> {
          return { revokeAllFor: async () => void this.revoked++ } as never;
        }
        public revoke(): Promise<void> {
          return this.revokeTokensOf({ type: 'user', id: 'u-1' } as never, {} as never);
        }
      }
      for (const [value, revoked] of [[true, 1], [undefined, 1], ['false', 1], [false, 0]] as const) {
        const probe = new Probe();
        Object.defineProperty(probe, 'RevokeTokens', { value });
        await probe.revoke();
        expect(probe.revoked, String(value)).to.eq(revoked);
      }
    });

    it('PasswordExpirationJob reads enabled and maxAgeDays; the Deps seam keeps its own literals equal to the schema defaults', async () => {
      const { child, configuration } = await boot(SCHEMAS, { authn: { local: { expiration: { enabled: true, maxAgeDays: 7 } } } });
      const job = readingFrom(new PasswordExpirationJob(), child) as unknown as { Enabled: boolean; MaxAgeDays: number };
      expect([job.Enabled, job.MaxAgeDays]).to.deep.eq([true, 7]);
      expect(configuration.get('authn.local.expiration.maxAgeDays')).to.eq(7);
      const defaults = (await boot(SCHEMAS, LOCAL)).configuration;
      expect([defaults.get('authn.local.expiration.enabled'), defaults.get('authn.local.expiration.maxAgeDays')]).to.deep.eq([false, 31]);
    });
  });
});
