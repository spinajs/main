// The child app of route-groups-boot.test.ts: the built package as an app loads it, with the 3.0 controllers scanned
// and only the strategy packages named on the command line loaded. No database: the probes stop at the route gates,
// the authentication policies and the field checks. Prints one JSON line.
//
//   node route-groups-app.cjs <esm|cjs> <packages, comma separated> <groups probed with a session, comma separated> <controller cache dir>
//
// A .cjs file, so one source serves both builds: `import()` takes the ESM build, `require` the CJS one.

const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const http = require('node:http');

const [mode, packagesArg = '', probedArg = '', cacheDir] = process.argv.slice(2);
if (!cacheDir) throw new Error('no controller cache dir given');
const ESM = mode === 'esm';
const FORMAT = ESM ? 'mjs' : 'cjs';
const PACKAGES = packagesArg.split(',').filter(Boolean);
const PROBED = probedArg.split(',').filter(Boolean);
const PKG_ROOT = resolve(__dirname, '..', '..');
const WORKSPACE = resolve(PKG_ROOT, '..');

const load = async (spec) => (ESM ? await import(spec) : require(spec));
const loadFile = (path) => load(ESM ? pathToFileURL(path).href : path);
const lib = (pkg, file) => join(WORKSPACE, pkg, 'lib', FORMAT, file);

const USER = { login: 'route-groups@example.test', password: 'Route-Groups-Pass-1' };

/**
 * Every N8b route: method, path, the body a session sends (a re-authentication wherever a route takes one), and the
 * body an anonymous caller sends when it differs (one an open route refuses before its service, which has no database here).
 */
const ROUTES = {
  password: [
    ['GET', '/auth/password/policy'],
    ['POST', '/auth/password/reset-request', { login: USER.login }, {}],
    ['POST', '/auth/password/reset', { login: USER.login, secret: 'x', password: 'Brand-New-Pass-1' }, { password: 'Brand-New-Pass-1' }],
    ['PATCH', '/user/password', { oldPassword: USER.password, password: 'Brand-New-Pass-1' }],
  ],
  mfa: [
    ['GET', '/user/mfa'],
    ['POST', '/user/mfa', { reauthPassword: USER.password }],
    ['POST', '/user/mfa/confirm', { code: '123456' }],
    ['POST', '/user/mfa/disable', { code: '123456', reauthPassword: USER.password }],
    ['POST', '/user/mfa/recovery-codes', { reauthPassword: USER.password }],
  ],
  tokens: [
    ['GET', '/user/tokens'],
    ['POST', '/user/tokens', { name: 'boot', expiresAt: new Date(Date.now() + 86400000).toISOString(), reauthPassword: USER.password }],
    ['DELETE', '/user/tokens/00000000-0000-4000-8000-000000000000'],
  ],
  keys: [
    ['GET', '/user/keys'],
    ['POST', '/user/keys', { jwk: { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43) }, proof: { challengeId: 'x', signature: 'y' }, reauthPassword: USER.password }],
    ['DELETE', '/user/keys/some-kid'],
    ['POST', '/auth/keys/challenge', { purpose: 'register' }],
    ['POST', '/auth/keys/login', { keyId: 'some-kid', challengeId: 'x', signature: 'y' }],
  ],
};

function send(port, method, path, body, cookie) {
  return new Promise((done, fail) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { accept: 'application/json', origin: `http://127.0.0.1:${port}` };
    if (payload !== undefined) Object.assign(headers, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    if (cookie) headers.cookie = cookie;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
        done({ status: res.statusCode, body: parsed, setCookie: [].concat(res.headers['set-cookie'] ?? []) });
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error(`${method} ${path}: no answer in 30 s`)));
    req.on('error', fail);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const answerOf = (res) => ({ status: res.status, error: typeof res.body === 'object' && res.body !== null ? (typeof res.body.error === 'string' ? res.body.error : res.body.error?.code ?? null) : null });

async function main() {
  for (const k of ['NODE_ENV', 'APP_ENV']) delete process.env[k];

  const di = await load('@spinajs/di');
  const { DI, Bootstrapper } = di;
  if (ESM) DI.setESMModuleSupport();
  const { Configuration, FrameworkConfiguration } = await load('@spinajs/configuration');
  const { Controllers, HttpServer, BaseController } = await load('@spinajs/http');
  await load('@spinajs/log');
  const { fsService } = await load('@spinajs/fs');
  const contracts = await load('@spinajs/authn/contracts');
  const kit = await load('@spinajs/authn-testing');
  const express = (await load('express')).default ?? (await load('express'));
  const cookieParser = (await load('cookie-parser')).default ?? (await load('cookie-parser'));
  const { SessionProvider } = await load('@spinajs/authn-session');

  const controllersDir = join(PKG_ROOT, 'lib', FORMAT, 'v3', 'controllers');

  class RouteGroupsConfiguration extends FrameworkConfiguration {
    async resolve() {
      await super.resolve();
      // Shipped configs add their compiled controller dirs (users-http's among them); this app scans authn-http's only one,
      // v3/controllers (pinned in route-table-n8c.test.ts).
      this.set(['system', 'dirs', 'controllers'], [controllersDir]);
      // The children of one test run in parallel from one cwd; sharing @spinajs/http's controller cache there, one child
      // read an entry another was still writing.
      this.set(
        ['fs', 'providers'],
        this.get(['fs', 'providers']).map((p) => (p.name === '__fs_controller_cache__' ? { ...p, basePath: cacheDir } : p)),
      );
    }

    onLoad() {
      return {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
        system: { dirs: { controllers: [controllersDir] } },
        fs: { defaultProvider: 'fs-temp', providers: [{ service: 'fsNative', name: 'fs-temp', basePath: join(PKG_ROOT, 'test', 'files') }] },
        http: { port: 0, cookie: { secret: 'route-groups-' + 'Zq8Lw2Rt'.repeat(6) }, middlewares: [express.json(), cookieParser()], AcceptHeaders: 1 },
        authn: {
          session: { service: 'MemorySessionStore', expiration: { service: 'SlidingCappedExpiration', ttl: 120, maxLifetime: 1440 }, pendingTtlSeconds: 300 },
          strategies: [{ name: 'local', service: 'RouteGroupsPasswordStrategy' }],
          throttle: { service: 'RouteGroupsThrottle' },
          freshAuth: { maxAgeSeconds: 1 },
          ...(PACKAGES.includes('totp') ? { mfa: { steps: [{ name: 'totp', service: 'TotpMfaStep' }], encryptionKey: { secret: 'ab'.repeat(32) } } } : {}),
          // Without an audience the key routes stay off (KeyRoutesOn).
          ...(PACKAGES.includes('keys') ? { keys: { assertion: { audience: 'https://route-groups.example.test' } } } : {}),
        },
      };
    }
  }

  const identities = new kit.FakeIdentityStore();
  const passwords = new kit.MemoryPasswordCredentialStore();
  const throttle = new kit.RecordingThrottle();
  const events = new kit.RecordingEventSink();
  const principals = new kit.RecordingPrincipalFactory();
  const strategy = kit.FakeStrategy.password({ identities, passwords, name: 'local' });
  const bind = (base, name, value) => DI.register({ [name]: () => value }[name]).as(base);

  DI.register(RouteGroupsConfiguration).as(Configuration);
  bind(contracts.IdentityStore, 'RouteGroupsIdentityStore', identities);
  bind(contracts.PasswordCredentialStore, 'RouteGroupsPasswordStore', passwords);
  bind(contracts.PrincipalFactory, 'RouteGroupsPrincipalFactory', principals);
  bind(contracts.AuthnThrottle, 'RouteGroupsThrottle', throttle);
  bind(contracts.AuthnEventSink, 'RouteGroupsEventSink', events);
  bind(contracts.AuthenticationStrategy, 'RouteGroupsPasswordStrategy', strategy);
  await (await loadFile(join(PKG_ROOT, 'lib', FORMAT, 'v3', 'register.js'))).registerAuthnHttpV3();

  for (const p of PACKAGES) {
    if (p === 'local') await load('@spinajs/authn-local');
    else if (p === 'token') await loadFile(lib('authn-token', join('service', 'index.js')));
    else if (p === 'keys') await load('@spinajs/authn-keys');
    else if (p === 'totp') {
      await load('@spinajs/authn-totp/service');
      // TotpMfaStep needs a store for login's enrolment check; nobody is enrolled here.
      const { MfaSecretStore } = await loadFile(lib('authn-totp', join('store', 'store.js')));
      bind(MfaSecretStore, 'RouteGroupsMfaStore', { get: async () => null });
    } else throw new Error(`unknown package ${p}`);
  }

  for (const b of await DI.resolve(Array.ofType(Bootstrapper))) await b.bootstrap();
  await DI.resolve(Configuration);
  await DI.resolve(fsService);
  await DI.resolve(Controllers);
  const server = await DI.resolve(HttpServer);
  await server.start();
  const port = server.Server.address().port;

  const routes = [];
  for (const ci of await DI.get(Controllers).Controllers) {
    for (const layer of ci.instance?.Router?.stack ?? []) {
      if (!layer.route) continue;
      for (const [method, on] of Object.entries(layer.route.methods)) if (on) routes.push(`${method.toUpperCase()} ${layer.route.path}`);
    }
  }
  const controllers = (DI.getRegisteredTypes(BaseController) ?? []).map((t) => t.name);

  const anonymous = {};
  for (const [group, list] of Object.entries(ROUTES)) for (const [method, path, body, anonymousBody] of list) anonymous[`${method} ${path}`] = { group, ...answerOf(await send(port, method, path, anonymousBody ?? body)) };

  const ref = identities.add({ login: USER.login, email: USER.login });
  await passwords.set(ref, kit.fakeHash(USER.password));
  const login = await send(port, 'POST', '/auth/login', USER);
  const cookie = login.setCookie.map((c) => c.split(';')[0]).join('; ');
  // authn.freshAuth.maxAgeSeconds is 1: from here on the session is stale, so a route that ran its fresh-auth check
  // would verify reauthPassword.
  await new Promise((r) => setTimeout(r, 2100));
  const whoami = await send(port, 'GET', '/auth', undefined, cookie);

  const mark = { attempts: throttle.attempts.length, succeeds: throttle.succeeds.length, events: events.all().length };
  const session = {};
  for (const group of PROBED) for (const [method, path, body] of ROUTES[group]) session[`${method} ${path}`] = { group, ...answerOf(await send(port, method, path, body, cookie)) };
  const touched = {
    attempts: throttle.attempts.slice(mark.attempts).map((a) => a.flow),
    succeeds: throttle.succeeds.slice(mark.succeeds).map((a) => a.flow),
    events: events
      .all()
      .slice(mark.events)
      .map((e) => `${e.type}/${e.outcome}`),
  };

  // The same probe can see a re-authentication: with the token routes on, the stale session's reauthPassword is verified
  // before the field checks refuse the nameless token.
  let control = null;
  if (PACKAGES.includes('token')) {
    const before = { attempts: throttle.attempts.length, events: events.all().length };
    const res = await send(port, 'POST', '/user/tokens', { reauthPassword: USER.password }, cookie);
    control = {
      ...answerOf(res),
      attempts: throttle.attempts.slice(before.attempts).map((a) => a.flow),
      events: events
        .all()
        .slice(before.events)
        .map((e) => `${e.type}/${e.outcome}`),
    };
  }

  // After the probes, so a gate that loaded a package on a request shows here. The configuration loader reads every
  // package's config file, users' included; ESM lists no loaded modules, but users' bootstrapper registers on import.
  const usersModules = ESM ? [] : Object.keys(require.cache).filter((f) => /[\\/]users[\\/]lib[\\/]/.test(f) && !/[\\/]config[\\/]/.test(f));
  const bootstrappers = (DI.getRegisteredTypes(Bootstrapper) ?? []).map((t) => t.name);
  const sessionProviders = (DI.getRegisteredTypes(SessionProvider) ?? []).map((t) => t.name);
  const registered = {
    PasswordService: DI.RootContainer.hasRegistered(contracts.PasswordService),
    TotpService: DI.RootContainer.hasRegistered('TotpService'),
    TokenService: DI.RootContainer.hasRegistered(contracts.TokenService),
    KeyRegistry: DI.RootContainer.hasRegistered(contracts.KeyRegistry),
  };

  await server.stop();
  console.log(JSON.stringify({ mode, packages: PACKAGES, usersModules, bootstrappers, sessionProviders, registered, routes, controllers, anonymous, login: login.status, whoami: whoami.status, session, touched, control }));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
