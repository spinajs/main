import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn/schemas';
import { AUTHN_LOCAL_CONFIGURATION_SCHEMA } from '../src/schema.js';
import { AuthnLocalConfigBootstrapper } from '../src/bootstrap.js';

import authnLocal from '../src/config/authn-local.js';
import { AUTHN_LOCAL_DEFAULTS } from '../src/defaults.js';
import { Argon2PasswordHasher } from '../src/hasher.js';
import { LocalPasswordPolicy } from '../src/policy.js';
import { LocalPasswordService } from '../src/service.js';
import { PasswordExpirationJob } from '../src/expiration.js';
import { boot, disposeBooted, readingFrom, violationsOf } from './support/config-boot.js';
import { registeredSchemasAfter } from './support/registered-schemas.js';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA, AUTHN_LOCAL_CONFIGURATION_SCHEMA];

/** `authn.local.policy.blocklist` of the built shipped config, loaded in a fresh process under `env`. */
function shippedBlocklistUnder(env: Record<string, string>): unknown {
  const file = pathToFileURL(join(process.cwd(), 'lib', 'config', 'authn-local.js')).href;
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'APP_ENV' && k !== 'NODE_ENV' && k !== 'NODE_OPTIONS'));
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(file)}); process.stdout.write(JSON.stringify(m.default.authn.local.policy.blocklist));`], {
    env: { ...base, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (run.status !== 0) throw new Error(`loading the shipped config failed: ${run.stderr}`);
  return JSON.parse(run.stdout) as unknown;
}
const LOCAL = { authn: { local: {} } };
const bad = (local: Record<string, unknown>) => violationsOf(SCHEMAS, { authn: { local } });

describe('authn.local through the schema', function () {
  this.timeout(30000);
  afterEach(disposeBooted);

  describe('defaults', () => {
    it('AuthnLocalConfigBootstrapper registers the authn.local fragment', () => {
      expect(AUTHN_LOCAL_CONFIGURATION_SCHEMA.$configurationModule).to.eq('authn.local');
      expect(registeredSchemasAfter(() => new AuthnLocalConfigBootstrapper().bootstrap())).to.include(AUTHN_LOCAL_CONFIGURATION_SCHEMA);
    });

    // The single authn schema filled authn.local only when the app named it; the fragment is there only with authn-local.
    it('with no user config, the effective authn.local equals what the former single authn schema filled for authn.local: {}', async () => {
      const expected = {
        hasher: { maxQueue: 64 },
        pepper: { secret: null, version: 1 },
        legacyHashes: [],
        policy: { minLength: 8, maxLength: 128, rule: null, blocklist: null, similarity: true },
        hibp: { url: 'https://api.pwnedpasswords.com/range/', timeoutMs: 2000 },
        generator: { length: 16, characters: ['abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789'] },
        reset: { ttlSeconds: 3600, url: '', revokeTokens: true },
        invite: { ttlSeconds: 900 },
        verify: { ttlSeconds: 86400, url: '' },
        emailCode: { ttlSeconds: 600 },
        expiration: { enabled: false, maxAgeDays: 31 },
        mail: { delivery: 'queue' },
      };
      expect((await boot(SCHEMAS, {})).configuration.get('authn.local')).to.deep.eq(expected);
      expect((await boot(SCHEMAS, LOCAL)).configuration.get('authn.local')).to.deep.eq(expected);
    });

    it('fills every key the classes used to default in code', async () => {
      const { configuration } = await boot(SCHEMAS, LOCAL);
      expect(configuration.get('authn.local.hasher.maxConcurrent')).to.eq(undefined);
      expect(configuration.get('authn.local.hasher.maxQueue')).to.eq(64);
      expect(configuration.get('authn.local.pepper')).to.deep.eq({ secret: null, version: 1 });
      expect(configuration.get('authn.local.policy')).to.deep.eq({ minLength: 8, maxLength: 128, rule: null, blocklist: null, similarity: true });
      expect(configuration.get('authn.local.hibp')).to.deep.eq({ url: 'https://api.pwnedpasswords.com/range/', timeoutMs: 2000 });
      expect(configuration.get('authn.local.generator.length')).to.eq(16);
      expect(configuration.get('authn.local.generator.characters')).to.have.length(3);
      expect(configuration.get('authn.local.reset')).to.deep.eq({ ttlSeconds: 3600, url: '', revokeTokens: true });
      expect(configuration.get('authn.local.invite.ttlSeconds')).to.eq(900);
      expect(configuration.get('authn.local.emailCode.ttlSeconds')).to.eq(600);
      expect(configuration.get('authn.local.expiration')).to.deep.eq({ enabled: false, maxAgeDays: 31 });
    });

    it('AUTHN_LOCAL_DEFAULTS, the fallback of the deps and options seams, is what the schema fills', async () => {
      const { configuration } = await boot(SCHEMAS, LOCAL);
      const filled = configuration.get<Record<string, Record<string, unknown>>>('authn.local');
      expect(AUTHN_LOCAL_DEFAULTS).to.deep.eq({
        hasher: { maxQueue: filled.hasher.maxQueue },
        policy: { minLength: filled.policy.minLength, maxLength: filled.policy.maxLength, similarity: filled.policy.similarity },
        hibp: filled.hibp,
        generator: filled.generator,
        reset: filled.reset,
        invite: filled.invite,
        verify: filled.verify,
        emailCode: filled.emailCode,
        expiration: filled.expiration,
        mail: filled.mail,
      });
    });

    it('keeps the shipped package config equal to the schema defaults it repeats', async () => {
      const { configuration } = await boot(SCHEMAS, LOCAL);
      const shipped = authnLocal.authn.local;
      expect(configuration.get('authn.local.hasher.maxQueue')).to.eq(shipped.hasher.maxQueue);
      expect(configuration.get('authn.local.pepper.version')).to.eq(shipped.pepper.version);
      expect(configuration.get('authn.local.policy.minLength')).to.eq(shipped.policy.minLength);
      expect(configuration.get('authn.local.policy.maxLength')).to.eq(shipped.policy.maxLength);
      expect(configuration.get('authn.local.reset.revokeTokens')).to.eq(shipped.reset.revokeTokens);
      expect(configuration.get('authn.local.mail.delivery')).to.eq(shipped.mail.delivery);
      expect(configuration.get('authn.local.verify')).to.deep.eq(shipped.verify);
      expect(configuration.get('authn.local.emailCode')).to.deep.eq(shipped.emailCode);
      expect(configuration.get('authn.local.policy.similarity')).to.eq(shipped.policy.similarity);
      expect(configuration.get('authn.local.hibp')).to.deep.eq(shipped.hibp);
    });

    // The shipped config is evaluated once per process, so each env gets its own process.
    for (const [label, env, expected] of [
      ['production', { APP_ENV: 'production' }, 'HibpPasswordBlocklist'],
      ['staging', { APP_ENV: 'staging' }, 'HibpPasswordBlocklist'],
      ['NODE_ENV production', { NODE_ENV: 'production' }, 'HibpPasswordBlocklist'],
      ['development', { APP_ENV: 'development' }, null],
      ['test', { APP_ENV: 'test' }, null],
      ['no env named, which the configuration loads as development', {}, null],
    ] as const) {
      it(`ships ${String(expected)} as authn.local.policy.blocklist under ${label} (D3)`, () => {
        expect(shippedBlocklistUnder(env)).to.eq(expected);
      });
    }

    it('ships AuthnMailJob on its own queue connection and lists the job directory', () => {
      expect(authnLocal.queue.routing.AuthnMailJob).to.deep.eq({ connection: 'authn-mail' });
      expect(authnLocal.queue.connections.map((c) => c.name)).to.include('authn-mail');
      expect(authnLocal.system.dirs.jobs.every((d) => /queue$/.test(d))).to.eq(true);
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
        [{ hasher: { maxQueue: -1 } }, 'authn.local.hasher.maxQueue'],
        [{ hasher: { maxQueue: 1.5 } }, 'authn.local.hasher.maxQueue'],
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
        // Not coerced: a null or 'false' would otherwise keep every API token alive after a reset.
        [{ reset: { revokeTokens: null } }, 'authn.local.reset.revokeTokens'],
        [{ reset: { revokeTokens: 'false' } }, 'authn.local.reset.revokeTokens'],
        [{ reset: { revokeTokens: 'true' } }, 'authn.local.reset.revokeTokens'],
        [{ reset: { revokeTokens: 0 } }, 'authn.local.reset.revokeTokens'],
        [{ invite: { ttlSeconds: 0 } }, 'authn.local.invite.ttlSeconds'],
        [{ emailCode: { ttlSeconds: 0 } }, 'authn.local.emailCode.ttlSeconds'],
        [{ expiration: { maxAgeDays: 0 } }, 'authn.local.expiration.maxAgeDays'],
        [{ expiration: { maxAgeDays: -3 } }, 'authn.local.expiration.maxAgeDays'],
        [{ mail: { delivery: 'smtp' } }, 'authn.local.mail.delivery'],
        [{ mail: { delivery: null } }, 'authn.local.mail.delivery'],
        [{ mail: { transport: 'queue' } }, 'authn.local.mail.transport'],
      ];
      for (const [local, path] of cases) expect(await bad(local), JSON.stringify(local)).to.include(path);
    });

    it('refuses argon2 cost keys under hasher (H30), a maxConcurrent that is no number, a pepper without secret and short lengths', async () => {
      for (const key of ['memoryCost', 'timeCost', 'parallelism', 'hashLength', 'saltLength', 'type']) {
        expect(await bad({ hasher: { service: 'Argon2PasswordHasher', [key]: 1 } }), key).to.include(`authn.local.hasher.${key}`);
      }
      for (const maxConcurrent of ['eight', { n: 8 }]) expect(await bad({ hasher: { maxConcurrent } }), JSON.stringify(maxConcurrent)).to.include('authn.local.hasher.maxConcurrent');
      expect(await bad({ pepper: { version: 1 } })).to.include('authn.local.pepper.secret');
      expect(await bad({ policy: { minLength: 0 } })).to.include('authn.local.policy.minLength');
      expect(await bad({ policy: { maxLength: 7 } })).to.include('authn.local.policy.maxLength');
    });

    it('takes previous peppers as { secret, version } with distinct versions, the implicit version 1 included (D9)', async () => {
      expect(await bad({ pepper: { secret: null, version: 1, previous: [] } })).to.deep.eq([]);
      expect(await bad({ pepper: { secret: 'x', version: 999999999 } })).to.deep.eq([]);
      expect(await bad({ pepper: { secret: 'x', version: 3, previous: [{ secret: 'y', version: 2 }, { secret: 'z', version: 1 }] } })).to.deep.eq([]);
      expect(await bad({ pepper: { secret: 'x', previous: [{ secret: 'y' }] } })).to.include('authn.local.pepper.previous.0.version');
      expect(await bad({ pepper: { secret: 'x', previous: [{ secret: 'y', version: 0 }] } })).to.include('authn.local.pepper.previous.0.version');
      expect(await bad({ pepper: { secret: 'x', version: 2, previous: [{ secret: 'y', version: 2 }] } })).to.include('authn.local.pepper.previous.0.version');
      expect(await bad({ pepper: { secret: 'x', previous: [{ secret: 'y', version: 1 }] } })).to.include('authn.local.pepper.previous.0.version');
    });

    it('coerces a numeric string, as the app validator does', async () => {
      const { configuration } = await boot(SCHEMAS, { authn: { local: { hasher: { maxConcurrent: '4' } } } });
      expect(configuration.get('authn.local.hasher.maxConcurrent')).to.eq(4);
    });

    it('accepts equal bounds, a fractional expiry and a rotation', async () => {
      expect(await bad({ policy: { minLength: 12, maxLength: 12 } })).to.deep.eq([]);
      expect(await bad({ expiration: { enabled: true, maxAgeDays: 0.5 } })).to.deep.eq([]);
      expect(await bad({ pepper: { secret: 'x', version: 2, previous: [{ secret: 'y', version: 1 }] } })).to.deep.eq([]);
      expect(await bad({ policy: { minLength: 12, maxLength: 64 } })).to.deep.eq([]);
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

    it('the schema refuses an empty pepper secret; null and an absent pepper mean no pepper', async () => {
      expect(await bad({ pepper: { secret: '', version: 1 } })).to.include('authn.local.pepper.secret');
      expect(await bad({ pepper: { secret: null, version: 1 } })).to.deep.eq([]);
      for (const local of [{ pepper: { secret: null } }, {}]) {
        const { child } = await boot(SCHEMAS, { authn: { local } });
        const hasher = readingFrom(new Argon2PasswordHasher(), child);
        await hasher.resolve();
        expect((await hasher.hash('correct horse battery')).startsWith('$sp'), JSON.stringify(local)).to.eq(false);
      }
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
