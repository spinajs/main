import 'mocha';
import { expect } from 'chai';
import { createHmac } from 'node:crypto';
import { AUTHN_CONFIGURATION_SCHEMA, AuthnService, AuthnThrottle, IdentityStore, PrincipalFactory, SessionIssuer } from '@spinajs/authn';
import { DEFAULT_THROTTLE_PARAMS, THROTTLE_FLOWS, backoffDelayMs } from '@spinajs/authn/contracts';
import type { ThrottleKey } from '@spinajs/authn/contracts';
import { FakeIdentityStore, MemorySessionIssuer, RecordingPrincipalFactory } from '@spinajs/authn-testing';
import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { InvalidOperation, InvalidOption } from '@spinajs/exceptions';

import { DbAuthnThrottle } from '../src/index.js';
import type { DbThrottleOptions } from '../src/index.js';
import { configurationViolations, createTestApp, disposeTestApps, setPastSchema } from '@spinajs/testing';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA];
const HASH_KEY = 'k'.repeat(40);
const bad = (authn: Record<string, unknown>) => configurationViolations({ schemas: SCHEMAS, config: { authn } });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A throttle DI builds in its own child of `from`, so it reads the configuration of `from`. */
async function throttleIn(from: IContainer, options?: DbThrottleOptions): Promise<DbAuthnThrottle> {
  return from.child().resolve(DbAuthnThrottle, options ? [undefined, options] : undefined);
}

describe('DbAuthnThrottle configuration', () => {
  afterEach(disposeTestApps);

  it("uses authn core's throttle parameters, not a copy", () => {
    expect(THROTTLE_FLOWS).to.deep.eq(['login', 'mfa', 'reset', 'reauth', 'register']);
    expect(DEFAULT_THROTTLE_PARAMS.login.account).to.deep.eq({ free: 5, baseDelayMs: 1000, maxDelayMs: 60000 });
    expect([1, 4, 5, 6, 7, 11, 12].map((n) => backoffDelayMs({ free: 5, baseDelayMs: 1000, maxDelayMs: 60000 }, n))).to.deep.eq([0, 0, 1000, 2000, 4000, 60000, 60000]);
  });

  it('reads the schema defaults when authn.throttle is not configured', async () => {
    const { container: child } = await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: {} });
    const throttle = await throttleIn(child);
    await throttle.init();
    expect(clone(throttle.params)).to.deep.eq(clone(DEFAULT_THROTTLE_PARAMS));
  });

  it('snapshots authn.throttle at init: frozen, and not the live configuration object', async () => {
    const { container: child, config: configuration } = await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: {} });
    const throttle = await throttleIn(child);
    await throttle.init();
    expect(throttle.params.login.account?.free).to.eq(5);
    expect(Object.isFrozen(throttle.params)).to.eq(true);
    expect(Object.isFrozen(throttle.params.login.account)).to.eq(true);
    configuration.get<{ login: { account: { free: number } } }>('authn.throttle').login.account.free = 9;
    expect(throttle.params.login.account?.free).to.eq(5);
  });

  it('fails with InvalidOperation when authn.throttle is unset, not a TypeError', async () => {
    // Loading DbAuthnThrottle registers the authn schema in the root; DI.clearCache() drops it, as this does.
    const registered = [...(DI.RootContainer.Cache.get('__configurationSchema__', false) as object[])];
    DI.uncache('__configurationSchema__' as never);
    let error: unknown;
    try {
      const { container: child } = await createTestApp({ scope: 'child', bootstrap: false, schemas: [], config: {} });
      const throttle = await throttleIn(child);
      await throttle.init();
    } catch (e) {
      error = e;
    } finally {
      for (const s of registered) DI.register(s).asValue('__configurationSchema__');
    }
    expect(error).to.be.instanceOf(InvalidOperation);
  });

  it('takes explicit params as given, without a container', () => {
    const throttle = new DbAuthnThrottle(DEFAULT_THROTTLE_PARAMS);
    expect(throttle.params).to.eq(DEFAULT_THROTTLE_PARAMS);
  });

  it('refuses explicit params outside the schema ranges, in every flow, naming the key', () => {
    for (const flow of THROTTLE_FLOWS) {
      for (const [key, value] of [['free', -1], ['baseDelayMs', Number.NaN], ['maxDelayMs', 0]] as const) {
        const params = clone(DEFAULT_THROTTLE_PARAMS) as unknown as Record<string, Record<string, Record<string, unknown>>>;
        params[flow].account[key] = value;
        expect(() => new DbAuthnThrottle(params as never), `${flow}.${key}`).to.throw(InvalidOption, `authn.throttle.${flow}.account.${key}`);
      }
    }
    expect(() => new DbAuthnThrottle({ ...DEFAULT_THROTTLE_PARAMS, resetAfterSeconds: 0 })).to.throw(InvalidOption, 'authn.throttle.resetAfterSeconds');
  });

  it('refuses limits set past the schema before init', async () => {
    const { container: child, config: configuration } = await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: {} });
    setPastSchema(configuration, 'authn.throttle.reset.ip.maxDelayMs', 0);
    const throttle = await throttleIn(child);
    let error: unknown;
    await throttle.init().catch((e: unknown) => (error = e));
    expect(error).to.be.instanceOf(InvalidOption);
    expect(String(error)).to.contain('authn.throttle.reset.ip.maxDelayMs');
  });

  it("keys rows with authn.audit.hashKey.secret from the container's configuration", async () => {
    const { container: child } = await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: { authn: { audit: { hashKey: { secret: HASH_KEY } } } } });
    const throttle = await throttleIn(child);
    await throttle.init();
    const key: ThrottleKey = { kind: 'account', value: 'keyed@example.test' };
    expect(throttle.rowKey('login', key)).to.eq(createHmac('sha256', HASH_KEY).update('login|account|keyed@example.test', 'utf8').digest('base64url'));
  });

  it('names the bad key instead of merging or throwing from the reader', async () => {
    expect(await bad({ throttle: { logins: {} } })).to.include('authn.throttle.logins');
    expect(await bad({ throttle: { login: { acount: {} } } })).to.include('authn.throttle.login.acount');
    expect(await bad({ throttle: { login: { account: { free: -1, baseDelayMs: 1, maxDelayMs: 1 } } } })).to.include('authn.throttle.login.account.free');
    expect(await bad({ throttle: { resetAfterSeconds: 0 } })).to.include('authn.throttle.resetAfterSeconds');
    expect(await bad({ throttle: { global: { free: 1 } } })).to.include.members(['authn.throttle.global.baseDelayMs', 'authn.throttle.global.maxDelayMs']);
    expect(await bad({ throttle: { login: { account: { free: 2 } } } })).to.include('authn.throttle.login.account.baseDelayMs');
  });
});

describe('DbAuthnThrottle without authn.audit.hashKey.secret', () => {
  const KEY: ThrottleKey = { kind: 'account', value: 'unkeyed@example.test' };
  // The key 3.0 alphas fell back to; anyone reading authn_throttle could test guessed logins against it.
  const publicRowKey = createHmac('sha256', 'spinajs:authn-orm:throttle').update('login|account|unkeyed@example.test', 'utf8').digest('base64url');

  afterEach(async () => {
    DI.uncache(DbAuthnThrottle);
    await disposeTestApps();
  });

  async function checkError(throttle: DbAuthnThrottle, booting: Parameters<DbAuthnThrottle['checkConfiguration']>[0]): Promise<unknown> {
    try {
      await throttle.checkConfiguration(booting);
    } catch (e) {
      return e;
    }
    return undefined;
  }

  it('refuses a production boot when the throttle reads no key, naming the key', async () => {
    for (const audit of [{}, { hashKey: { secret: null } }]) {
      const { container: child, config: configuration } = await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: { authn: { audit } }, env: 'production' });
      const error = await checkError(await throttleIn(child), configuration);
      expect(error, JSON.stringify(audit)).to.be.instanceOf(InvalidOption);
      expect((error as Error).message).to.contain('authn.audit.hashKey.secret');
    }
  });

  it('judges the key the throttle uses, under the env of the booting configuration', async () => {
    const keyed = await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: { authn: { audit: { hashKey: { secret: HASH_KEY } } } }, env: 'production' });
    const unkeyed = await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: {}, env: 'production' });
    const lenient = await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: {}, env: 'test' });
    const throttle = (from: IContainer, hashKey?: string | null) => throttleIn(from, hashKey !== undefined ? { hashKey } : undefined);
    expect(await checkError(await throttle(unkeyed.container), keyed.config), 'only the booting configuration has the key').to.be.instanceOf(InvalidOption);
    expect(await checkError(await throttle(keyed.container), unkeyed.config), 'only the throttle configuration has the key').to.eq(undefined);
    expect(await checkError(await throttle(unkeyed.container, HASH_KEY), unkeyed.config), 'a key given to the constructor').to.eq(undefined);
    expect(await checkError(await throttle(keyed.container, null), keyed.config), 'hashKey null over a configured secret').to.be.instanceOf(InvalidOption);
    expect(await checkError(await throttle(unkeyed.container), lenient.config), 'booting in test').to.eq(undefined);
  });

  for (const env of ['development', 'test']) {
    it(`keys rows with a random key of this process in ${env}, never a public constant`, async () => {
      const { container: child, config: configuration } = await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: {}, env: env });
      const a = await throttleIn(child);
      const b = await throttleIn((await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: {}, env: env })).container);
      await a.checkConfiguration(configuration);
      await a.init();
      await b.init();
      expect(a.rowKey('login', KEY)).to.eq(b.rowKey('login', KEY));
      expect(a.rowKey('login', KEY)).to.not.eq(publicRowKey);
    });
  }

  it('keys rows of an instance given neither a configuration nor a key with the random key of this process', () => {
    const throttle = new DbAuthnThrottle(DEFAULT_THROTTLE_PARAMS);
    expect(throttle.rowKey('login', KEY)).to.not.eq(publicRowKey);
    expect(throttle.rowKey('login', KEY)).to.eq(new DbAuthnThrottle(DEFAULT_THROTTLE_PARAMS, { hashKey: null }).rowKey('login', KEY));
  });

  describe('when the authn service boots on it', () => {
    const COOKIE_SECRET = 'c'.repeat(48);

    function bind(child: IContainer, base: Class<unknown>, name: string, value: unknown): void {
      const factory = { [name]: () => value }[name];
      child.register(factory).as(base);
    }

    /** The service boots in a child of its own; `throttle` reads the configuration of another child, as the root singleton reads the root's. */
    async function bootService(env: string, audit: Record<string, unknown>, throttle?: { audit: Record<string, unknown>; hashKey?: string | null }): Promise<unknown> {
      const service = throttle ? 'SeparateDbThrottle' : 'DbAuthnThrottle';
      const { container: child } = await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: { authn: { strategies: [], throttle: { service }, audit }, http: { cookie: { secret: COOKIE_SECRET } } }, env: env });
      if (throttle) {
        const own = await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: { authn: { audit: throttle.audit } }, env: env });
        bind(child, AuthnThrottle, service, await throttleIn(own.container, throttle.hashKey !== undefined ? { hashKey: throttle.hashKey } : undefined));
      }
      bind(child, IdentityStore, 'HashKeyIdentityStore', new FakeIdentityStore());
      bind(child, PrincipalFactory, 'HashKeyPrincipalFactory', new RecordingPrincipalFactory());
      bind(child, SessionIssuer, 'HashKeySessionIssuer', new MemorySessionIssuer());
      return child.resolve(AuthnService);
    }

    async function bootError(...args: Parameters<typeof bootService>): Promise<unknown> {
      try {
        await bootService(...args);
      } catch (e) {
        return e;
      }
      return undefined;
    }

    const KEYED = { hashKey: { secret: HASH_KEY } };

    it('fails the boot in production, naming the key', async () => {
      const error = await bootError('production', {});
      expect(error).to.be.instanceOf(InvalidOption);
      expect((error as Error).message).to.contain('authn.audit.hashKey.secret');
    });

    it('fails the boot in production when only the service configuration has the key', async () => {
      expect(await bootError('production', KEYED, { audit: {} })).to.be.instanceOf(InvalidOption);
    });

    it('fails the boot in production when hashKey null overrides the configured secret', async () => {
      expect(await bootError('production', KEYED, { audit: KEYED, hashKey: null })).to.be.instanceOf(InvalidOption);
    });

    it('boots in production when the throttle configuration has the key, and in test without any', async () => {
      expect(await bootError('production', {}, { audit: KEYED })).to.eq(undefined);
      expect(await bootError('test', {})).to.eq(undefined);
    });
  });
});
