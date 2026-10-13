import * as chai from 'chai';
import 'mocha';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DI } from '@spinajs/di';
import { FakeMfaStep } from '@spinajs/authn-testing';
import { InvalidOption } from '@spinajs/exceptions';

import { AUTHN_ENV_FALLBACK_WARNING, AUTHN_PUBLIC_COOKIE_SECRET, authnAppEnv, authnSecretFindings, isLenientAuthnEnv } from '../../src/index.js';
import type { AuthnConfigFinding } from '../../src/index.js';
import { secretStoringSteps } from '../../src/service/boot/secrets.js';
import { buildCore } from '../behaviour/harness.js';
import { TestLog, useTestLog } from '../audit/test-log.js';

const expect = chai.expect;
const PACKAGES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

type Values = Record<string, unknown>;

/**
 * A Configuration stand-in: `get` over a plain object, the app env under process.env.APP_ENV. Unless `named` is false,
 * the env counts as given by `--env` (the `Env` of a Configuration).
 */
function config(env: string | undefined, values: Values = {}, named = true): { readonly Env?: string; get<T>(path: string | string[]): T } {
  const tree: Values = { ...values, process: { env: env === undefined ? {} : { APP_ENV: env } } };
  return {
    Env: named ? env : undefined,
    get<T>(path: string | string[]): T {
      const parts = Array.isArray(path) ? path : path.split('.');
      return parts.reduce<unknown>((n, k) => (n !== null && typeof n === 'object' ? (n as Values)[k] : undefined), tree) as T;
    },
  };
}

const STRONG = 'a'.repeat(64);

function values(over: { cookie?: unknown; pepper?: unknown; mfaKey?: unknown } = {}): Values {
  return {
    http: { cookie: { secret: 'cookie' in over ? over.cookie : STRONG } },
    authn: {
      local: { pepper: 'pepper' in over ? over.pepper : { secret: null, version: 1 } },
      mfa: { encryptionKey: { secret: 'mfaKey' in over ? over.mfaKey : STRONG } },
    },
  };
}

const none = async (): Promise<readonly string[]> => [];
const totp = async (): Promise<readonly string[]> => ['totp'];

async function findings(env: string | undefined, v: Values, steps = none, named = true): Promise<AuthnConfigFinding[]> {
  return authnSecretFindings(config(env, v, named), steps);
}

/** Runs each case of the enclosing suite with no APP_ENV and no NODE_ENV in the process. */
function withoutProcessEnv(): void {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ['APP_ENV', 'NODE_ENV']) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

const levels = (f: readonly AuthnConfigFinding[]): string[] => f.map((x) => `${x.topic}:${x.level}`);

describe('authn boot: app env', () => {
  it('reads the env the configuration resolved', () => {
    expect(authnAppEnv(config('staging'))).to.eq('staging');
    expect(authnAppEnv(config(undefined))).to.eq(undefined);
  });

  it('is lenient only in development and test (any spelling the configuration accepts)', () => {
    for (const env of ['development', 'dev', 'test']) expect(isLenientAuthnEnv(env), env).to.eq(true);
    for (const env of ['production', 'prod', 'staging', 'qa', 'Development', 'TEST', '', undefined]) expect(isLenientAuthnEnv(env), String(env)).to.eq(false);
  });

  it('mirrors the public cookie secret of @spinajs/http', () => {
    const http = readFileSync(join(PACKAGES, 'http', 'src', 'config', 'http.ts'), 'utf8');
    expect(http).to.match(/cookie: \{\s*secret: '([^']+)'/);
    expect(http.match(/cookie: \{\s*secret: '([^']+)'/)![1]).to.eq(AUTHN_PUBLIC_COOKIE_SECRET);
  });

  describe('with no env set (SR-16)', () => {
    withoutProcessEnv();

    it('counts the fallback to development as no env', () => {
      expect(authnAppEnv(config('development', {}, false))).to.eq(undefined);
      expect(authnAppEnv(config('development'))).to.eq('development');
      expect(authnAppEnv(config('staging', {}, false))).to.eq('staging');
    });

    it('stays strict when an env other than development is set after the configuration fell back', async () => {
      for (const k of ['NODE_ENV', 'APP_ENV']) {
        process.env[k] = 'production';
        try {
          expect(authnAppEnv(config('development', {}, false)), k).to.eq(undefined);
          expect(levels(await findings('development', values({ cookie: AUTHN_PUBLIC_COOKIE_SECRET }), none, false)), k).to.deep.eq(['secrets:error']);
        } finally {
          delete process.env[k];
        }
      }
    });

    it('takes NODE_ENV or a DI-registered APP_ENV as a named env', () => {
      process.env.NODE_ENV = 'development';
      expect(authnAppEnv(config('development', {}, false))).to.eq('development');
      delete process.env.NODE_ENV;
      const registered = DI.get<Values>('process.env');
      DI.register({ APP_ENV: 'development' }).asValue('process.env', true);
      try {
        expect(authnAppEnv(config('development', {}, false))).to.eq('development');
      } finally {
        DI.uncache('process.env');
        if (registered) DI.register(registered).asValue('process.env');
      }
    });

    it('makes a public or missing cookie secret an error', async () => {
      for (const cookie of [AUTHN_PUBLIC_COOKIE_SECRET, null]) {
        const f = await findings('development', values({ cookie }), none, false);
        expect(levels(f), String(cookie)).to.deep.eq(['secrets:error']);
        expect(f[0].message).to.contain('http.cookie.secret').and.contain('unset');
      }
    });

    it('still only warns when development or test is named', async () => {
      for (const env of ['development', 'test']) {
        expect(levels(await findings(env, values({ cookie: AUTHN_PUBLIC_COOKIE_SECRET }))), env).to.deep.eq(['secrets:warning']);
        process.env.NODE_ENV = env;
        try {
          expect(levels(await findings(env, values({ cookie: AUTHN_PUBLIC_COOKIE_SECRET }), none, false)), `NODE_ENV ${env}`).to.deep.eq(['secrets:warning']);
        } finally {
          delete process.env.NODE_ENV;
        }
      }
    });
  });
});

describe('authn boot: secrets (A24, SR-16)', () => {
  it('passes strong secrets in production with no finding', async () => {
    expect(await findings('production', values(), totp)).to.deep.eq([]);
  });

  for (const env of ['production', 'staging', undefined]) {
    it(`refuses a missing or public cookie secret in ${env ?? 'an unset env'}`, async () => {
      for (const cookie of [undefined, null, '', AUTHN_PUBLIC_COOKIE_SECRET, 42]) {
        const f = await findings(env, values({ cookie }));
        expect(levels(f), String(cookie)).to.deep.eq(['secrets:error']);
        expect(f[0].message).to.contain('http.cookie.secret');
      }
    });
  }

  for (const env of ['development', 'test']) {
    it(`only warns about a public or missing cookie secret in ${env}`, async () => {
      expect(levels(await findings(env, values({ cookie: AUTHN_PUBLIC_COOKIE_SECRET })))).to.deep.eq(['secrets:warning']);
      expect(levels(await findings(env, values({ cookie: null })))).to.deep.eq(['secrets:warning']);
    });
  }

  it('never puts a secret value in a message', async () => {
    const all = [
      ...(await findings('production', values({ cookie: AUTHN_PUBLIC_COOKIE_SECRET }))),
      ...(await findings('production', values({ cookie: null }))),
    ];
    expect(all.length).to.be.greaterThan(1);
    for (const f of all) expect(f.message).to.not.contain(AUTHN_PUBLIC_COOKIE_SECRET);
  });

  describe('MFA encryption key (D3)', () => {
    it('is required in production when a configured step stores secrets', async () => {
      for (const mfaKey of [null, undefined, '']) {
        const f = await findings('production', values({ mfaKey }), totp);
        expect(levels(f), String(mfaKey)).to.deep.eq(['secrets:error']);
        expect(f[0].message).to.contain('authn.mfa.encryptionKey.secret').and.contain('"totp"');
      }
    });

    it('is not required when no configured step stores secrets', async () => {
      expect(await findings('production', values({ mfaKey: null }), none)).to.deep.eq([]);
    });

    it('does not ask for the steps when the key is set', async () => {
      let asked = 0;
      await findings('production', values(), async () => {
        asked++;
        return ['totp'];
      });
      expect(asked).to.eq(0);
    });

    it('only warns in development', async () => {
      expect(levels(await findings('development', values({ mfaKey: null }), totp))).to.deep.eq(['secrets:warning']);
    });

    // Fails closed: a step that cannot be resolved may be one that stores secrets.
    const broken = async (): Promise<readonly string[]> => {
      throw new Error('step failed: hunter2');
    };

    it('counts steps that cannot be resolved as storing secrets: an error outside development and test', async () => {
      for (const env of ['production', 'staging']) {
        const f = await findings(env, values({ mfaKey: null }), broken);
        expect(levels(f), env).to.deep.eq(['secrets:error']);
        expect(f[0].message).to.contain('authn.mfa.encryptionKey.secret').and.contain('while resolving the MFA steps').and.not.contain('hunter2');
      }
    });

    it('only warns about steps that cannot be resolved in development', async () => {
      const f = await findings('development', values({ mfaKey: null }), broken);
      expect(levels(f)).to.deep.eq(['secrets:warning']);
      expect(f[0].message).to.not.contain('hunter2');
    });

  });

  describe('pepper (A03, D9)', () => {
    it('may be off', async () => {
      for (const pepper of [undefined, null, { secret: null, version: 1 }, { secret: null }]) {
        expect(await findings('production', values({ pepper })), JSON.stringify(pepper)).to.deep.eq([]);
      }
    });

    it('accepts previous peppers with their own versions', async () => {
      const pepper = { secret: STRONG, version: 3, previous: [{ secret: 'b'.repeat(64), version: 2 }, { secret: 'c'.repeat(64), version: 1 }] };
      expect(await findings('production', values({ pepper }))).to.deep.eq([]);
    });

    it('leaves the shape of the pepper and the MFA key to the schema', async () => {
      expect(await findings('production', values({ mfaKey: 42 }))).to.deep.eq([]);
      expect(await findings('production', values({ pepper: { secret: STRONG, version: 0, previous: {} } }))).to.deep.eq([]);
      expect(await findings('production', values({ pepper: { secret: '', version: 1 } }))).to.deep.eq([]);
    });
  });
});

describe('MfaStep.storesSecrets (D3)', () => {
  const stepsOf = (...steps: FakeMfaStep[]) => new Map(steps.map((s) => [s.name, s]));
  const named = (name: string, storesSecrets?: unknown) => {
    const step = new FakeMfaStep();
    Object.defineProperty(step, 'name', { value: name });
    if (storesSecrets !== undefined) Object.defineProperty(step, 'storesSecrets', { value: storesSecrets });
    return step;
  };

  it('defaults to false on a step that does not declare it', async () => {
    expect(new FakeMfaStep().storesSecrets).to.eq(false);
    expect(secretStoringSteps(stepsOf(named('plain')))).to.deep.eq([]);
  });

  it('lists the steps that declare storesSecrets: true', async () => {
    expect(secretStoringSteps(stepsOf(named('plain'), named('totp', true)))).to.deep.eq(['totp']);
  });

});

describe('DefaultAuthnService boot: secrets', function () {
  // Each case boots one or two containers.
  this.timeout(20000);
  useTestLog();

  const unresolvableStep = { http: { cookie: { secret: STRONG } }, authn: { mfa: { steps: [{ name: 'totp', service: 'NotRegistered' }], encryptionKey: { secret: null } } } };

  it('fails boot in production when the MFA key is missing and the steps cannot be resolved', async () => {
    let error: unknown;
    try {
      const p = await buildCore({ env: 'production' }, { strategies: [], raw: unresolvableStep });
      await p.dispose();
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(InvalidOption);
    expect((error as Error).message).to.contain('authn.mfa.encryptionKey.secret').and.contain('NotRegistered');
    const p = await buildCore({ env: 'development' }, { strategies: [], raw: unresolvableStep });
    await p.dispose();
  });

  describe('with no env set (SR-16)', () => {
    withoutProcessEnv();

    const cookie = (secret: string): Values => ({ http: { cookie: { secret } } });

    it('logs that no env is set', async () => {
      const p = await buildCore({}, { strategies: [], unsetEnv: true, raw: cookie(STRONG) });
      await p.dispose();
      expect(TestLog.of('authn-boot').filter((e) => e.level === 'warn' && e.message === AUTHN_ENV_FALLBACK_WARNING)).to.have.length(1);
    });

    it('SR-16 a deployment without any env refuses the public cookie secret', async () => {
      let error: unknown;
      try {
        const p = await buildCore({}, { strategies: [], unsetEnv: true, raw: cookie(AUTHN_PUBLIC_COOKIE_SECRET) });
        await p.dispose();
      } catch (e) {
        error = e;
      }
      expect(error).to.be.instanceOf(InvalidOption);
      expect((error as Error).message).to.contain('http.cookie.secret');
    });

    it('boots with the public cookie secret when development is named', async () => {
      const p = await buildCore({ env: 'development' }, { strategies: [], raw: cookie(AUTHN_PUBLIC_COOKIE_SECRET) });
      await p.dispose();
    });
  });
});
