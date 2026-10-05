import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface InjectedField {
  name: string;
  isUsers: boolean;
  isSession: boolean;
  sameAsLegacy: boolean;
}

interface Facts {
  issuerStoreName: string;
  issuerStoreIsSession: boolean;
  issuerStoreIsUsers: boolean;
  issuerExpirationName: string;
  issuerExpirationIsSessionCapped: boolean;
  issuerExpirationIsUsersCapped: boolean;
  sessionProviders: { name: string; fromSession: boolean }[];
  sessionExpirations: { name: string; fromSession: boolean }[];
  sharedClassNames: string[];
  legacyStoreIsUsers: boolean;
  legacyStoreIsSession: boolean;
  legacyExpirationName: string;
  legacyExpirationIsUsersCapped: boolean;
  legacyExpirationIsSessionCapped: boolean;
  legacyInjected?: InjectedField;
  legacyInjectedError?: string;
  controllerFields?: InjectedField[];
  controllerError?: string;
}

/** The configured `authn.session.service` and `authn.session.expiration.service`. */
interface Names {
  store: string;
  strategy: string;
}

// Plain JS for a fresh ESM or CJS child: the built packages, loaded as an app loads them, so nothing earlier in
// this mocha process (which has users and authn-session loaded and registered) can mask a clash.
const body = ({ store, strategy }: Names) => `
  const STORE = ${JSON.stringify(store)};
  const STRATEGY = ${JSON.stringify(strategy)};
  class TestConfiguration extends cfgMod.Configuration {
    Config = {
      authn: { session: { service: STORE, expiration: { service: STRATEGY, ttl: 30, maxLifetime: 480 }, pendingTtlSeconds: 300 } },
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

  // a name authn-session does not export stands for a 3.0 store or strategy of another package or of the app
  // (DbSessionStore, ...), registered under authn-session's base as session-provider-db registers its store
  const fakes = [];
  if (!(STORE in session)) {
    const Store = { [STORE]: class extends session.MemorySessionStore {} }[STORE];
    di.DI.register(Store).as(session.SessionProvider);
    fakes.push(Store);
  }
  if (!(STRATEGY in session)) {
    const Strategy = { [STRATEGY]: class extends session.SlidingCappedExpiration {} }[STRATEGY];
    di.DI.register(Strategy).as(session.SessionExpirationProvider);
    fakes.push(Strategy);
  }

  const classes = (m) => Object.values(m).filter((v) => typeof v === 'function' && /^class\\b/.test(Function.prototype.toString.call(v)));
  const sessionClasses = [...classes(session), ...fakes];
  const sessionNames = new Set(classes(session).map((c) => c.name));
  const registered = (t) => (di.DI.getRegisteredTypes(t) ?? []).map((c) => ({ name: c.name, fromSession: sessionClasses.includes(c) }));

  const issuer = await di.DI.resolve(contracts.SessionIssuer);
  const store = issuer.Store;
  const legacy = await di.DI.resolve(users.SessionProvider);
  const legacyExpiration = legacy.Expiration;
  const field = (f) => ({
    name: f?.constructor?.name,
    isUsers: f instanceof users.SessionProvider,
    isSession: f instanceof session.SessionProvider,
    sameAsLegacy: f === legacy,
  });
  const failure = (e) => e.constructor.name + ': ' + e.message;

  // a 2.x field with an explicit type
  class LegacyConsumer {}
  cfgMod.AutoinjectService('authn.session', users.SessionProvider)(LegacyConsumer.prototype, 'Store');
  let legacyInjected, legacyInjectedError;
  try {
    legacyInjected = field((await di.DI.resolve(LegacyConsumer)).Store);
  } catch (e) {
    legacyInjectedError = failure(e);
  }

  // users-http Security.ts and the 2.x authn-http controllers: the type comes from design:type (the 2.x alias), and
  // controllers resolve through Array.ofType, as Controllers.resolve() does at boot
  class BaseController {}
  class SecurityLikeController extends BaseController {}
  Reflect.defineMetadata('design:type', users.SessionProvider, SecurityLikeController.prototype, 'Sessions');
  cfgMod.AutoinjectService('authn.session')(SecurityLikeController.prototype, 'Sessions');
  di.DI.register(SecurityLikeController).as(BaseController);
  let controllerFields, controllerError;
  try {
    controllerFields = (await di.DI.resolve(Array.ofType(BaseController))).map((c) => field(c.Sessions));
  } catch (e) {
    controllerError = failure(e);
  }

  console.log(JSON.stringify({
    issuerStoreName: store.constructor.name,
    issuerStoreIsSession: store instanceof session.MemorySessionStore,
    issuerStoreIsUsers: store instanceof users.SessionProvider,
    issuerExpirationName: store.Expiration.constructor.name,
    issuerExpirationIsSessionCapped: store.Expiration instanceof session.SlidingCappedExpiration,
    issuerExpirationIsUsersCapped: store.Expiration instanceof users.SlidingCappedExpiration,
    sessionProviders: registered(session.SessionProvider),
    sessionExpirations: registered(session.SessionExpirationProvider),
    sharedClassNames: [...new Set(classes(users).map((c) => c.name).filter((n) => sessionNames.has(n)))].sort(),
    legacyStoreIsUsers: legacy instanceof users.MemorySessionStore,
    legacyStoreIsSession: legacy instanceof session.SessionProvider,
    legacyExpirationName: legacyExpiration.constructor.name,
    legacyExpirationIsUsersCapped: legacyExpiration instanceof users.SlidingCappedExpiration,
    legacyExpirationIsSessionCapped: legacyExpiration instanceof session.SessionExpirationProvider,
    legacyInjected,
    legacyInjectedError,
    controllerFields,
    controllerError,
  }));
`;

const PACKAGES = { users: '@spinajs/users', session: '@spinajs/authn-session' } as const;
type Order = readonly (keyof typeof PACKAGES)[];

const esm = (order: Order, names: Names) => `
  const di = await import('@spinajs/di');
  const cfgMod = await import('@spinajs/configuration');
  const loaded = {};
  for (const k of ${JSON.stringify(order)}) loaded[k] = await import(${JSON.stringify(PACKAGES)}[k]);
  const { users, session } = loaded;
  const contracts = await import('@spinajs/authn/contracts');
  ${body(names)}
`;

const cjs = (order: Order, names: Names) => `
  (async () => {
    const di = require('@spinajs/di');
    const cfgMod = require('@spinajs/configuration');
    const loaded = {};
    for (const k of ${JSON.stringify(order)}) loaded[k] = require(${JSON.stringify(PACKAGES)}[k]);
    const { users, session } = loaded;
    const contracts = require('@spinajs/authn/contracts');
    ${body(names)}
  })().catch((e) => { console.error(e); process.exit(1); });
`;

function run(inputType: 'module' | 'commonjs', source: string): Facts {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, [`--input-type=${inputType}`, '-e', source], { cwd: PKG_ROOT, encoding: 'utf8', env });
  expect(r.status, r.stderr).to.eq(0);
  const lines = r.stdout.trim().split(/\r?\n/);
  return JSON.parse(lines[lines.length - 1]);
}

const USERS_STORE: InjectedField = { name: 'LegacyMemorySessionStore', isUsers: true, isSession: false, sameAsLegacy: true };

const CASES = [
  {
    title: "the shipped names: the issuer gets authn-session's store and strategy, the 2.x provider keeps users' own",
    names: { store: 'MemorySessionStore', strategy: 'SlidingCappedExpiration' },
    sessionProviders: ['MemorySessionStore'],
    sessionExpirations: ['AbsoluteExpiration', 'SlidingCappedExpiration', 'SlidingExpiration'],
  },
  {
    title: "3.0-only names: the issuer gets the named 3.0 classes, every 2.x field falls back to users' 2.x store",
    names: { store: 'DbSessionStore', strategy: 'IdleCappedExpiration' },
    sessionProviders: ['DbSessionStore', 'MemorySessionStore'],
    sessionExpirations: ['AbsoluteExpiration', 'IdleCappedExpiration', 'SlidingCappedExpiration', 'SlidingExpiration'],
  },
] as const;

describe('users and authn-session loaded together share no DI class name (N8c-D1)', function () {
  this.timeout(120000);

  for (const [label, inputType, build] of [
    ['ESM', 'module', esm],
    ['CJS', 'commonjs', cjs],
  ] as const) {
    for (const order of [['users', 'session'], ['session', 'users']] as const) {
      for (const c of CASES) {
        it(`${label}, ${order.join(' before ')}, ${c.title}`, () => {
          const f = run(inputType, build(order, c.names));

          expect({
            sharedClassNames: f.sharedClassNames,
            issuerStoreName: f.issuerStoreName,
            issuerStoreIsSession: f.issuerStoreIsSession,
            issuerStoreIsUsers: f.issuerStoreIsUsers,
            issuerExpirationName: f.issuerExpirationName,
            issuerExpirationIsSessionCapped: f.issuerExpirationIsSessionCapped,
            issuerExpirationIsUsersCapped: f.issuerExpirationIsUsersCapped,
            sessionProvidersFromElsewhere: f.sessionProviders.filter((t) => !t.fromSession).map((t) => t.name),
            sessionProviders: f.sessionProviders.map((t) => t.name).sort(),
            sessionExpirationsFromElsewhere: f.sessionExpirations.filter((t) => !t.fromSession).map((t) => t.name),
            sessionExpirations: f.sessionExpirations.map((t) => t.name).sort(),
            legacyStoreIsUsers: f.legacyStoreIsUsers,
            legacyStoreIsSession: f.legacyStoreIsSession,
            legacyExpirationName: f.legacyExpirationName,
            legacyExpirationIsUsersCapped: f.legacyExpirationIsUsersCapped,
            legacyExpirationIsSessionCapped: f.legacyExpirationIsSessionCapped,
            legacyInjected: f.legacyInjected,
            legacyInjectedError: f.legacyInjectedError,
            controllerFields: f.controllerFields,
            controllerError: f.controllerError,
          }).to.deep.eq({
            sharedClassNames: [],
            issuerStoreName: c.names.store,
            issuerStoreIsSession: true,
            issuerStoreIsUsers: false,
            issuerExpirationName: c.names.strategy,
            issuerExpirationIsSessionCapped: true,
            issuerExpirationIsUsersCapped: false,
            sessionProvidersFromElsewhere: [],
            sessionProviders: c.sessionProviders,
            sessionExpirationsFromElsewhere: [],
            sessionExpirations: c.sessionExpirations,
            // a strategy name the 2.x base does not carry falls back to users' 2.x default
            legacyStoreIsUsers: true,
            legacyStoreIsSession: false,
            legacyExpirationName: 'LegacySlidingCappedExpiration',
            legacyExpirationIsUsersCapped: true,
            legacyExpirationIsSessionCapped: false,
            // the configured store name, 3.0 or not, gives every 2.x field users' 2.x store and never fails at boot
            legacyInjected: USERS_STORE,
            legacyInjectedError: undefined,
            controllerFields: [USERS_STORE],
            controllerError: undefined,
          });
        });
      }
    }
  }
});
