import * as chai from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { FakeIdentityStore, FakeMfaStep, FakeStrategy, MemoryPasswordCredentialStore } from '@spinajs/authn-testing';
import { InvalidOption } from '@spinajs/exceptions';

import { AUTHN_PUBLIC_COOKIE_SECRET, AuthenticationStrategy, AuthnThrottle, MfaStep, checkAuthnConfig } from '../../src/index.js';
import type { AuthnConfigFinding } from '../../src/index.js';
import { bind, configurationOf, useAuthnSchema } from '../behaviour/harness.js';
import { useTestLog } from '../audit/test-log.js';

const expect = chai.expect;

type Values = Record<string, unknown>;

const STRONG = 'a'.repeat(64);

/** A production app with every check satisfied: one listed strategy, strong secrets, a proxy and CORS set. */
function sound(): Values {
  return {
    http: { cookie: { secret: STRONG }, trustProxy: 1, cors: { origins: ['https://app.example.com'] } },
    authn: {
      strategies: [{ name: 'local', service: 'KitPassword' }],
      mfa: { steps: [{ name: 'fake', service: 'KitStep' }], encryptionKey: { secret: STRONG } },
      local: { pepper: { secret: null, version: 1 } },
    },
  };
}

const children: IContainer[] = [];

async function check(values: Values, opts: { env?: string; secretStep?: boolean; register?: (c: IContainer) => void } = {}): Promise<AuthnConfigFinding[]> {
  const child = DI.RootContainer.child();
  children.push(child);
  child.register(configurationOf(values, 'env' in opts ? opts.env : 'production', true)).as(Configuration);
  await child.resolve(Configuration);
  bind(child, AuthenticationStrategy, 'KitPassword', FakeStrategy.password({ identities: new FakeIdentityStore(), passwords: new MemoryPasswordCredentialStore() }));
  const step = new FakeMfaStep();
  if (opts.secretStep) Object.defineProperty(step, 'storesSecrets', { value: true });
  bind(child, MfaStep, 'KitStep', step);
  opts.register?.(child);
  return checkAuthnConfig(child);
}

const topics = (f: readonly AuthnConfigFinding[]): string[] => f.map((x) => `${x.topic}:${x.level}`);

function merge(base: Values, over: Values): Values {
  const out: Values = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = v !== null && typeof v === 'object' && !Array.isArray(v) && b !== null && typeof b === 'object' && !Array.isArray(b) ? merge(b as Values, v as Values) : v;
  }
  return out;
}

describe('authn:check-config', () => {
  useTestLog();

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  it('finds nothing in a sound production config', async () => {
    expect(await check(sound())).to.deep.eq([]);
  });

  describe('strategies', () => {
    it('warns when no strategy is listed', async () => {
      for (const strategies of [[], undefined]) {
        const f = await check(merge(sound(), { authn: { strategies } }));
        expect(topics(f), JSON.stringify(strategies)).to.deep.eq(['strategies:warning']);
      }
    });

    it('reports a listed service that is not registered, by entry and service name', async () => {
      const f = await check(merge(sound(), { authn: { strategies: [{ name: 'local', service: 'KitPassword' }, { name: 'jwt', service: 'JwtBearerStrategy' }] } }));
      expect(topics(f)).to.deep.eq(['strategies:error']);
      expect(f[0].message).to.contain('"jwt"').and.contain('"JwtBearerStrategy"');
    });

    it('leaves a list the schema refuses to the schema finding: no strategies duplicate', async () => {
      const child = DI.RootContainer.child();
      children.push(child);
      useAuthnSchema(child);
      child.register(configurationOf(merge(sound(), { authn: { strategies: [{ name: 'local', service: 'KitPassword' }, { name: 'local', service: 'Other' }] } }), 'production', true)).as(Configuration);
      const f = await checkAuthnConfig(child);
      expect(topics(f)).to.not.be.empty;
      expect(f.every((x) => x.topic === 'schema')).to.eq(true);
    });

    it('reports a schema violation as an error finding without echoing the value, instead of throwing', async () => {
      const child = DI.RootContainer.child();
      children.push(child);
      useAuthnSchema(child);
      child.register(configurationOf(merge(sound(), { authn: { strategies: [{ name: 'local', service: 'KitPassword', secret: 'hunter2' }, { name: 'local', service: 'Other' }] } }), 'production', true)).as(Configuration);
      const f = await checkAuthnConfig(child);
      expect(topics(f)).to.include('schema:error');
      expect(f.map((x) => x.message).join(' ')).to.contain('authn.strategies').and.not.contain('hunter2');
    });
  });

  describe('secrets', () => {
    it('reports a missing or public cookie secret as an error in production', async () => {
      for (const secret of [null, AUTHN_PUBLIC_COOKIE_SECRET]) {
        expect(topics(await check(merge(sound(), { http: { cookie: { secret } } }))), String(secret)).to.deep.eq(['secrets:error']);
      }
    });

    it('reports a public cookie secret as a warning in development', async () => {
      expect(topics(await check(merge(sound(), { http: { cookie: { secret: AUTHN_PUBLIC_COOKIE_SECRET } } }), { env: 'development' }))).to.deep.eq(['secrets:warning']);
    });

    it('asks the configured steps whether they store secrets (D3)', async () => {
      const noKey = merge(sound(), { authn: { mfa: { encryptionKey: { secret: null } } } });
      expect(await check(noKey)).to.deep.eq([]);
      expect(topics(await check(noKey, { secretStep: true }))).to.deep.eq(['secrets:error']);
    });

    it('reports steps that cannot be resolved instead of throwing', async () => {
      const f = await check(merge(sound(), { authn: { mfa: { steps: [{ name: 'totp', service: 'TotpMfaStep' }], encryptionKey: { secret: null } } } }));
      expect(topics(f)).to.deep.eq(['mfa:error']);
      expect(f[0].message).to.contain('TotpMfaStep');
    });
  });

  describe('env (SR-16 residual)', () => {
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

    it('warns when the deployment set no env and the configuration fell back to development', async () => {
      const f = await check(sound(), { env: undefined });
      expect(topics(f)).to.deep.eq(['env:warning']);
      expect(f[0].message).to.contain('development');
    });

    it('takes the APP_ENV of a DI-registered process.env as set, as the configuration does', async () => {
      const registered = DI.get<Values>('process.env');
      DI.register({ APP_ENV: 'development' }).asValue('process.env', true);
      try {
        expect(await check(sound(), { env: undefined })).to.deep.eq([]);
      } finally {
        DI.uncache('process.env');
        if (registered) DI.register(registered).asValue('process.env');
      }
    });

    it('says nothing when NODE_ENV or the env is set', async () => {
      process.env.NODE_ENV = 'production';
      expect(await check(sound(), { env: undefined })).to.deep.eq([]);
      delete process.env.NODE_ENV;
      expect(await check(sound(), { env: 'production' })).to.deep.eq([]);
    });
  });

  describe('proxy', () => {
    it('warns when neither authn.http.trustProxy nor http.trustProxy is set', async () => {
      const noProxy = merge(sound(), { http: { trustProxy: null } });
      expect(topics(await check(noProxy))).to.deep.eq(['proxy:warning']);
      expect(topics(await check(merge(noProxy, { authn: { http: { trustProxy: null } } })))).to.deep.eq(['proxy:warning']);
    });

    it('takes either key, and 0 or a CIDR list as set', async () => {
      const noProxy = merge(sound(), { http: { trustProxy: null } });
      for (const trustProxy of [0, 2, ['10.0.0.0/8']]) {
        expect(await check(merge(noProxy, { authn: { http: { trustProxy } } })), JSON.stringify(trustProxy)).to.deep.eq([]);
        expect(await check(merge(noProxy, { http: { trustProxy } })), JSON.stringify(trustProxy)).to.deep.eq([]);
      }
    });
  });

  describe('cors', () => {
    it('warns when http.cors.origins is empty: no cross-origin request is allowed (A31)', async () => {
      const f = await check(merge(sound(), { http: { cors: { origins: [] } } }));
      expect(topics(f)).to.deep.eq(['cors:warning']);
      expect(f[0].message).to.contain('no cross-origin request is allowed');
      expect(f[0].message).to.not.contain('allows every origin');
    });

    it('warns when http.cors is set without an origins list, as for an empty one', async () => {
      const v = sound();
      (v.http as Values).cors = { exposedHeaders: ['x-request-id'] };
      const f = await check(v);
      expect(topics(f)).to.deep.eq(['cors:warning']);
      expect(f[0].message).to.contain('no cross-origin request is allowed');
    });

    it('warns when http.cors.origins is not a list: @spinajs/http refuses to start', async () => {
      const f = await check(merge(sound(), { http: { cors: { origins: 'https://app.example.com' } } }));
      expect(topics(f)).to.deep.eq(['cors:warning']);
      expect(f[0].message).to.contain('not a list');
    });

    it('says nothing without http.cors: no CORS middleware, the same-origin rule holds', async () => {
      expect(await check(merge(sound(), { http: { cors: null } }))).to.deep.eq([]);
    });
  });

  describe('legacy keys', () => {
    it('warns about 2.x keys of the table', async () => {
      const f = await check(merge(sound(), { rbac: { password: { lockoutTime: 900 } } }));
      expect(topics(f)).to.deep.eq(['legacy:warning']);
      expect(f[0].message).to.contain('rbac.password.lockoutTime');
    });

    it('reports them as an error when rejectLegacyKeys is on', async () => {
      const f = await check(merge(sound(), { rbac: { password: { lockoutTime: 900 } }, authn: { config: { rejectLegacyKeys: true } } }));
      expect(topics(f)).to.deep.eq(['legacy:error']);
    });
  });

  describe('throttle', () => {
    const throttleNamed = (service: string, checkConfiguration?: (c: { get<T>(path: string): T }) => Promise<void>) => ({
      values: merge(sound(), { authn: { throttle: { service } } }),
      register: (c: IContainer) => bind(c, AuthnThrottle, service, { attempt: async () => ({ allowed: true }), succeed: async () => undefined, ...(checkConfiguration ? { checkConfiguration } : {}) }),
    });

    it('reports the refusal of the selected throttle as an error, with the booting configuration', async () => {
      let env: unknown;
      const t = throttleNamed('RefusingThrottle', async (c) => {
        env = c.get('process.env.APP_ENV');
        throw new InvalidOption('DbAuthnThrottle: authn.audit.hashKey.secret is not set');
      });
      const f = await check(t.values, { register: t.register });
      expect(topics(f)).to.deep.eq(['throttle:error']);
      expect(f[0].message).to.contain('authn.audit.hashKey.secret');
      expect(env).to.eq('production');
    });

    it('reports a throttle that cannot be selected as an error, as boot fails on it', async () => {
      const f = await check(merge(sound(), { authn: { throttle: { service: 'MissingThrottle' } } }));
      expect(topics(f)).to.deep.eq(['throttle:error']);
      expect(f[0].message).to.contain('"MissingThrottle"');
    });

    it('finds nothing when the throttle accepts the configuration or has no check', async () => {
      const accepting = throttleNamed('AcceptingThrottle', async () => undefined);
      expect(await check(accepting.values, { register: accepting.register })).to.deep.eq([]);
      const plain = throttleNamed('PlainThrottle');
      expect(await check(plain.values, { register: plain.register })).to.deep.eq([]);
    });
  });

  it('reports every topic at once and never throws', async () => {
    const bad = merge(sound(), { http: { cookie: { secret: null }, trustProxy: null, cors: { origins: [] } }, authn: { strategies: [] }, rbac: { session: { service: 'x' } } });
    expect(topics(await check(bad)).sort()).to.deep.eq(['cors:warning', 'legacy:warning', 'proxy:warning', 'secrets:error', 'strategies:warning']);
  });
});
