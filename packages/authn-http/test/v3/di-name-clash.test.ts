import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Facts {
  issuerStoreName: string;
  issuerStoreIsSession: boolean;
  issuerExpirationName: string;
  issuerExpirationIsSessionCapped: boolean;
  sessionProviders: { name: string; fromSession: boolean }[];
  sessionExpirations: { name: string; fromSession: boolean }[];
}

/** The configured `authn.session.service` and `authn.session.expiration.service`. */
interface Names {
  store: string;
  strategy: string;
}

// Plain JS for a fresh ESM or CJS child: the built package, loaded as an app loads it, so nothing registered earlier
// in this mocha process can mask a clash.
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
  const registered = (t) => (di.DI.getRegisteredTypes(t) ?? []).map((c) => ({ name: c.name, fromSession: sessionClasses.includes(c) }));

  const issuer = await di.DI.resolve(contracts.SessionIssuer);
  const store = issuer.Store;

  console.log(JSON.stringify({
    issuerStoreName: store.constructor.name,
    issuerStoreIsSession: store instanceof session.MemorySessionStore,
    issuerExpirationName: store.Expiration.constructor.name,
    issuerExpirationIsSessionCapped: store.Expiration instanceof session.SlidingCappedExpiration,
    sessionProviders: registered(session.SessionProvider),
    sessionExpirations: registered(session.SessionExpirationProvider),
  }));
`;

const esm = (names: Names) => `
  const di = await import('@spinajs/di');
  const cfgMod = await import('@spinajs/configuration');
  const session = await import('@spinajs/authn-session');
  const contracts = await import('@spinajs/authn/contracts');
  ${body(names)}
`;

const cjs = (names: Names) => `
  (async () => {
    const di = require('@spinajs/di');
    const cfgMod = require('@spinajs/configuration');
    const session = require('@spinajs/authn-session');
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

const CASES = [
  {
    title: "the shipped names: the issuer gets authn-session's store and strategy",
    names: { store: 'MemorySessionStore', strategy: 'SlidingCappedExpiration' },
    sessionProviders: ['MemorySessionStore'],
    sessionExpirations: ['AbsoluteExpiration', 'SlidingCappedExpiration', 'SlidingExpiration'],
  },
  {
    title: 'names of another package: the issuer gets the named classes',
    names: { store: 'DbSessionStore', strategy: 'IdleCappedExpiration' },
    sessionProviders: ['DbSessionStore', 'MemorySessionStore'],
    sessionExpirations: ['AbsoluteExpiration', 'IdleCappedExpiration', 'SlidingCappedExpiration', 'SlidingExpiration'],
  },
] as const;

describe('authn-session registers only its own DI classes (N8c-D1)', function () {
  this.timeout(120000);

  for (const [label, inputType, build] of [
    ['ESM', 'module', esm],
    ['CJS', 'commonjs', cjs],
  ] as const) {
    for (const c of CASES) {
      it(`${label}, ${c.title}`, () => {
        const f = run(inputType, build(c.names));

        expect({
          issuerStoreName: f.issuerStoreName,
          issuerStoreIsSession: f.issuerStoreIsSession,
          issuerExpirationName: f.issuerExpirationName,
          issuerExpirationIsSessionCapped: f.issuerExpirationIsSessionCapped,
          sessionProvidersFromElsewhere: f.sessionProviders.filter((t) => !t.fromSession).map((t) => t.name),
          sessionProviders: f.sessionProviders.map((t) => t.name).sort(),
          sessionExpirationsFromElsewhere: f.sessionExpirations.filter((t) => !t.fromSession).map((t) => t.name),
          sessionExpirations: f.sessionExpirations.map((t) => t.name).sort(),
        }).to.deep.eq({
          issuerStoreName: c.names.store,
          issuerStoreIsSession: true,
          issuerExpirationName: c.names.strategy,
          issuerExpirationIsSessionCapped: true,
          sessionProvidersFromElsewhere: [],
          sessionProviders: c.sessionProviders,
          sessionExpirationsFromElsewhere: [],
          sessionExpirations: c.sessionExpirations,
        });
      });
    }
  }
});
