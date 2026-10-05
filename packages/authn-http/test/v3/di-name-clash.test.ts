import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Facts {
  issuerStoreIsSession: boolean;
  issuerStoreIsUsers: boolean;
  issuerExpirationIsSessionCapped: boolean;
  issuerExpirationIsUsersCapped: boolean;
  sessionProviders: { name: string; fromSession: boolean }[];
  sessionExpirations: { name: string; fromSession: boolean }[];
  sharedClassNames: string[];
  legacyStoreIsUsers: boolean;
  legacyStoreIsSession: boolean;
  legacyExpirationIsUsersCapped: boolean;
  legacyExpirationIsSessionCapped: boolean;
  legacyInjectedIsUsers: boolean;
}

// Plain JS for a fresh ESM or CJS child: the built packages, loaded as an app loads them, so nothing earlier in
// this mocha process (which has users and authn-session loaded and registered) can mask a clash.
const BODY = `
  class TestConfiguration extends cfgMod.Configuration {
    Config = {
      authn: { session: { service: 'MemorySessionStore', expiration: { service: 'SlidingCappedExpiration', ttl: 30, maxLifetime: 480 }, pendingTtlSeconds: 300 } },
    };
    get RootConfig() { return this.Config; }
    get(path, defaultValue) {
      const v = (Array.isArray(path) ? path : path.split('.')).reduce((o, k) => (o == null ? undefined : o[k]), this.Config);
      return v === undefined ? defaultValue : v;
    }
    set() {}
    merge() {}
    async mergeSource() {}
    async load() {}
    onLoad() {}
  }
  di.DI.register(TestConfiguration).as(cfgMod.Configuration);
  await di.DI.resolve(cfgMod.Configuration);

  const classes = (m) => Object.values(m).filter((v) => typeof v === 'function' && /^class\\b/.test(Function.prototype.toString.call(v)));
  const sessionClasses = classes(session);
  const sessionNames = new Set(sessionClasses.map((c) => c.name));
  const registered = (t) => (di.DI.getRegisteredTypes(t) ?? []).map((c) => ({ name: c.name, fromSession: sessionClasses.includes(c) }));

  const issuer = await di.DI.resolve(contracts.SessionIssuer);
  const store = issuer.Store;
  const legacy = await di.DI.resolve(users.SessionProvider);
  const legacyExpiration = legacy.Expiration;
  // a 2.x controller field, as users-http and the 2.x authn-http controllers declare it
  class LegacyConsumer {}
  cfgMod.AutoinjectService('authn.session', users.SessionProvider)(LegacyConsumer.prototype, 'Store');
  const consumer = await di.DI.resolve(LegacyConsumer);

  console.log(JSON.stringify({
    issuerStoreIsSession: store instanceof session.MemorySessionStore,
    issuerStoreIsUsers: store instanceof users.MemorySessionStore,
    issuerExpirationIsSessionCapped: store.Expiration instanceof session.SlidingCappedExpiration,
    issuerExpirationIsUsersCapped: store.Expiration instanceof users.SlidingCappedExpiration,
    sessionProviders: registered(session.SessionProvider),
    sessionExpirations: registered(session.SessionExpirationProvider),
    sharedClassNames: [...new Set(classes(users).map((c) => c.name).filter((n) => sessionNames.has(n)))].sort(),
    legacyStoreIsUsers: legacy instanceof users.MemorySessionStore,
    legacyStoreIsSession: legacy instanceof session.MemorySessionStore,
    legacyExpirationIsUsersCapped: legacyExpiration instanceof users.SlidingCappedExpiration,
    legacyExpirationIsSessionCapped: legacyExpiration instanceof session.SlidingCappedExpiration,
    legacyInjectedIsUsers: consumer.Store instanceof users.MemorySessionStore,
  }));
`;

const PACKAGES = { users: '@spinajs/users', session: '@spinajs/authn-session' } as const;
type Order = readonly (keyof typeof PACKAGES)[];

const esm = (order: Order) => `
  const di = await import('@spinajs/di');
  const cfgMod = await import('@spinajs/configuration');
  const loaded = {};
  for (const k of ${JSON.stringify(order)}) loaded[k] = await import(${JSON.stringify(PACKAGES)}[k]);
  const { users, session } = loaded;
  const contracts = await import('@spinajs/authn/contracts');
  ${BODY}
`;

const cjs = (order: Order) => `
  (async () => {
    const di = require('@spinajs/di');
    const cfgMod = require('@spinajs/configuration');
    const loaded = {};
    for (const k of ${JSON.stringify(order)}) loaded[k] = require(${JSON.stringify(PACKAGES)}[k]);
    const { users, session } = loaded;
    const contracts = require('@spinajs/authn/contracts');
    ${BODY}
  })().catch((e) => { console.error(e); process.exit(1); });
`;

function run(inputType: 'module' | 'commonjs', body: string): Facts {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, [`--input-type=${inputType}`, '-e', body], { cwd: PKG_ROOT, encoding: 'utf8', env });
  expect(r.status, r.stderr).to.eq(0);
  const lines = r.stdout.trim().split(/\r?\n/);
  return JSON.parse(lines[lines.length - 1]);
}

describe('users and authn-session loaded together share no DI class name (N8c-D1)', function () {
  this.timeout(120000);

  for (const [label, inputType, build] of [
    ['ESM', 'module', esm],
    ['CJS', 'commonjs', cjs],
  ] as const) {
    for (const order of [['users', 'session'], ['session', 'users']] as const) {
      it(`${label}, ${order.join(' before ')}: the issuer gets authn-session's store and strategy, the 2.x provider keeps users' own`, () => {
        const f = run(inputType, build(order));

        expect({
          sharedClassNames: f.sharedClassNames,
          issuerStoreIsSession: f.issuerStoreIsSession,
          issuerStoreIsUsers: f.issuerStoreIsUsers,
          issuerExpirationIsSessionCapped: f.issuerExpirationIsSessionCapped,
          issuerExpirationIsUsersCapped: f.issuerExpirationIsUsersCapped,
          sessionProvidersFromElsewhere: f.sessionProviders.filter((t) => !t.fromSession).map((t) => t.name),
          sessionProviders: f.sessionProviders.map((t) => t.name),
          sessionExpirationsFromElsewhere: f.sessionExpirations.filter((t) => !t.fromSession).map((t) => t.name),
          sessionExpirations: f.sessionExpirations.map((t) => t.name).sort(),
          legacyStoreIsUsers: f.legacyStoreIsUsers,
          legacyStoreIsSession: f.legacyStoreIsSession,
          legacyExpirationIsUsersCapped: f.legacyExpirationIsUsersCapped,
          legacyExpirationIsSessionCapped: f.legacyExpirationIsSessionCapped,
          legacyInjectedIsUsers: f.legacyInjectedIsUsers,
        }).to.deep.eq({
          sharedClassNames: [],
          issuerStoreIsSession: true,
          issuerStoreIsUsers: false,
          issuerExpirationIsSessionCapped: true,
          issuerExpirationIsUsersCapped: false,
          sessionProvidersFromElsewhere: [],
          sessionProviders: ['MemorySessionStore'],
          sessionExpirationsFromElsewhere: [],
          sessionExpirations: ['AbsoluteExpiration', 'SlidingCappedExpiration', 'SlidingExpiration'],
          // a 3.0 strategy name in the config falls back to users' 2.x default
          legacyStoreIsUsers: true,
          legacyStoreIsSession: false,
          legacyExpirationIsUsersCapped: true,
          legacyExpirationIsSessionCapped: false,
          // the config names 'MemorySessionStore': a 2.x field picks users' store by that old name
          legacyInjectedIsUsers: true,
        });
      });
    }
  }
});
