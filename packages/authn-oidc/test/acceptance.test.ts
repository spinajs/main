/**
 * Plan N10 task 8, canvas-like acceptance (H36): an app with one generic provider configured only by its issuer URL
 * logs in over HTTP and gets a session, with the state and the links in the database (SQLite, and Postgres when the
 * shared test server answers). The IdP is the in-memory fake behind OidcHttpClient (no network to an IdP); N1's
 * AuthnService and N8a's session middleware are not merged, so the kit's FakeAuthnService and MemorySessionIssuer
 * stand in for them.
 */
import 'mocha';
import '@spinajs/log';
import { expect } from 'chai';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cs from 'cookie-signature';

import { Bootstrapper, DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { BaseController, Controllers, HttpServer, ServerMiddleware } from '@spinajs/http';
import { fsService } from '@spinajs/fs';
import { Orm, OrmDriver, QueryContext } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { PostgresOrmDriver } from '@spinajs/orm-postgres';
import { AuthenticationStrategy, AuthnService, ExternalLoginHook, IdentityLinkStore, SessionIssuer } from '@spinajs/authn/contracts';
import type { ExternalSubject, IdentityRef } from '@spinajs/authn/contracts';
import { DbIdentityLinkStore, DbNonceStore, NonceStore } from '@spinajs/authn-orm';
import { EnrolledMfaPolicy, FakeAuthnService, FakeBackoffThrottle, FakeIdentityStore, MemorySessionIssuer, RecordingEventSink, RecordingPrincipalFactory, throttleParams } from '@spinajs/authn-testing';

import { OidcController } from '../src/controllers/OidcController.js';
import { OidcHttpClient } from '../src/http/client.js';
import { OidcProviders } from '../src/providers.js';
import { OidcBootstrapper } from '../src/bootstrap.js';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FAKE_ISSUER, FakeIdp } from './support/fake-idp.js';

type DbKind = 'sqlite' | 'postgres';

/**
 * What the factories below hand out; each suite sets its own. The DI registry unregisters by type name, and every
 * factory's name is 'Function', so unregistering one would take others' factories (the logger's) with it: these are
 * registered once for the whole run instead.
 */
const current: { idp?: FakeIdp; nonces?: DbNonceStore; links?: DbIdentityLinkStore; sessions?: MemorySessionIssuer; service?: FakeAuthnService } = {};
let factoriesRegistered = false;
function registerFactories(): void {
  if (factoriesRegistered) return;
  factoriesRegistered = true;
  DI.register(() => current.idp!).as(OidcHttpClient);
  DI.register(() => current.nonces!).as(NonceStore);
  DI.register(() => current.links!).as(IdentityLinkStore);
  DI.register(() => current.sessions!).as(SessionIssuer);
  DI.register(() => current.service!).as(AuthnService);
}
const PG_SERVER = { Host: '127.0.0.1', Port: 15432, User: 'postgres', Password: 'postgres', Database: 'test' };
const COOKIE_SECRET = randomBytes(24).toString('hex');

class HookLog extends ExternalLoginHook {
  static calls: [IdentityRef, ExternalSubject][] = [];
  async afterLogin(identity: IdentityRef, external: ExternalSubject): Promise<void> {
    HookLog.calls.push([identity, external]);
  }
}

function configurationFor(connection: Record<string, unknown>) {
  return class AcceptanceConfiguration extends FrameworkConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();
      const c = this.Config as Record<string, any>;
      c.logger = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] };
      c.http = { ...c.http, port: 0, cookie: { ...c.http?.cookie, secret: COOKIE_SECRET } };
      // Only the controller under test: package defaults list the controller dirs of every installed package.
      c.system = { ...c.system, dirs: { ...c.system?.dirs, controllers: [] } };
      c.fs = {
        ...c.fs,
        defaultProvider: 'n10-acceptance',
        providers: [
          ...((c.fs?.providers ?? []) as { name?: string }[]).filter((p) => p.name !== '__fs_controller_cache__'),
          { service: 'fsNative', name: '__fs_controller_cache__', basePath: join(tmpdir(), 'spinajs-n10-acceptance-cache') },
          { service: 'fsNative', name: 'n10-acceptance', basePath: join(tmpdir(), 'spinajs-n10-acceptance') },
        ],
      };
      c.db = { ...c.db, DefaultConnection: connection.Name, Connections: [connection] };
      // The canvas-like setup: one generic provider, configured by its issuer URL only.
      c.authn = { ...c.authn, linking: { jit: false, byVerifiedEmail: false }, oidc: { providers: { corp: { issuer: FAKE_ISSUER, clientId: FAKE_CLIENT_ID, clientSecret: { secret: FAKE_CLIENT_SECRET } } } } };
    }
  };
}

async function pgAdmin(): Promise<OrmDriver> {
  const container = DI.child();
  const driver = await container.resolve<OrmDriver>(PostgresOrmDriver, [{ Name: 'n10-pg-admin', Driver: 'orm-driver-postgres', ...PG_SERVER, Pool: { Max: 1, AcquireTimeout: 15000 } }]);
  await driver.connect();
  return driver;
}

const raw = (driver: OrmDriver, sql: string, context = QueryContext.Select): Promise<any> =>
  (driver as unknown as { executeOnDb(sql: string, b: unknown[], c: QueryContext): Promise<any> }).executeOnDb(sql, [], context);

for (const kind of ['sqlite', 'postgres'] as DbKind[]) {
  describe(`authn-oidc canvas-like acceptance (${kind})`, function () {
    this.timeout(60000);

    let base: string;
    let idp: FakeIdp;
    let dbContainer: IContainer;
    let orm: Orm;
    let database: string | undefined;
    let identities: FakeIdentityStore;
    let sessions: MemorySessionIssuer;
    let links: DbIdentityLinkStore;
    let alice: IdentityRef;
    let flowName: string;
    let sessionName: string;
    const registered: unknown[] = [];

    const register = <T>(impl: Class<T>, as: Class<T>) => {
      DI.register(impl).as(as);
      registered.push(impl);
    };

    before(async function () {
      DI.setESMModuleSupport();
      let connection: Record<string, unknown>;
      if (kind === 'postgres') {
        let admin: OrmDriver;
        try {
          admin = await pgAdmin();
        } catch (err) {
          if (process.env.N10_REQUIRE_PG === '1') throw err;
          console.warn('      Postgres at 127.0.0.1:15432 is unreachable, suite skipped (N10_REQUIRE_PG=1 fails instead)');
          this.skip();
        }
        database = `n10_acceptance_${randomBytes(4).toString('hex')}`;
        try {
          await admin!.schema().createDatabase(database);
        } finally {
          await admin!.disconnect();
        }
        connection = { Name: 'n10-acceptance', Driver: 'orm-driver-postgres', ...PG_SERVER, Database: database, Migration: { OnStartup: true }, Pool: { AcquireTimeout: 15000 } };
      } else {
        connection = { Name: 'n10-acceptance', Driver: 'orm-driver-sqlite', Filename: ':memory:', Migration: { OnStartup: true } };
      }

      register(configurationFor(connection) as unknown as Class<Configuration>, Configuration);
      // The database in a child container, as authn-orm's own tests run it; the stores read it from there.
      dbContainer = DI.child();
      dbContainer.register(SqliteOrmDriver).as('orm-driver-sqlite');
      dbContainer.register(PostgresOrmDriver).as('orm-driver-postgres');
      orm = await dbContainer.resolve(Orm);

      idp = await FakeIdp.create(FAKE_ISSUER, ['RS256']);
      identities = new FakeIdentityStore();
      sessions = new MemorySessionIssuer();
      links = new DbIdentityLinkStore(undefined, { container: dbContainer });
      const nonces = new DbNonceStore(undefined, { container: dbContainer });
      alice = identities.add({ login: 'alice@example.test', email: 'alice@example.test' });

      current.idp = idp;
      current.nonces = nonces;
      current.links = links;
      current.sessions = sessions;
      registerFactories();
      register(HookLog, ExternalLoginHook);

      // What the app's boot does: bootstrappers, then the core lists 'oidc:corp' among authn.strategies (N1's registry
      // instantiates the registered factory of that name).
      await new OidcBootstrapper().bootstrap();
      const factory = (DI.getRegisteredTypes(AuthenticationStrategy) ?? []).find((t) => (t as { name?: string }).name === 'oidc:corp') as unknown as (c: IContainer) => Promise<AuthenticationStrategy>;
      expect(factory, 'the bootstrapper registers the oidc:corp strategy service').to.be.a('function');
      const strategy = await factory(DI.RootContainer);
      expect(strategy.name).to.eq('oidc:corp');

      const service = new FakeAuthnService({
        strategies: [strategy],
        throttle: new FakeBackoffThrottle(throttleParams({})),
        identities,
        links,
        linking: { jit: false, byVerifiedEmail: false },
        policy: new EnrolledMfaPolicy([]),
        steps: [],
        sessions,
        sinks: [new RecordingEventSink()],
        principals: new RecordingPrincipalFactory(),
      });
      current.service = service;
      register(OidcController, BaseController);

      for (const b of (await DI.resolve(Array.ofType(Bootstrapper))) as Bootstrapper[]) {
        if (!(b instanceof OidcBootstrapper)) await b.bootstrap();
      }
      await DI.resolve(fsService);
      await DI.resolve(Controllers);
      const server = (await DI.resolve(HttpServer)) as HttpServer;
      await server.start();
      base = `http://127.0.0.1:${(server.Server.address() as AddressInfo).port}`;
      const env = (await DI.resolve(OidcProviders)).env;
      const relaxed = env === 'test' || env === 'development' || env === 'dev';
      flowName = relaxed ? 'spinajs-oidc' : '__Host-spinajs-oidc';
      sessionName = relaxed ? 'ssid' : '__Host-ssid';
    });

    after(async () => {
      await DI.get(HttpServer)?.stop();
      DI.uncache(HttpServer);
      DI.uncache(Controllers);
      for (const type of DI.getRegisteredTypes(BaseController) ?? []) DI.uncache(type as Class<BaseController>);
      DI.uncache(BaseController);
      for (const type of DI.getRegisteredTypes(ServerMiddleware) ?? []) DI.uncache(type as Class<ServerMiddleware>);
      DI.uncache(ServerMiddleware);
      for (const impl of registered) DI.unregister(impl as Class<unknown>);
      registered.length = 0;
      DI.uncache(OidcProviders);
      DI.uncache(Configuration);
      HookLog.calls = [];
      await orm?.dispose();
      if (database) {
        const admin = await pgAdmin();
        try {
          await raw(admin, `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`, QueryContext.Schema);
        } finally {
          await admin.disconnect();
        }
      }
    });

    const cookiesOf = (res: Response): Record<string, string> =>
      Object.fromEntries(
        res.headers.getSetCookie().map((line) => {
          const pair = line.split(';')[0];
          const i = pair.indexOf('=');
          return [pair.slice(0, i), decodeURIComponent(pair.slice(i + 1))];
        }),
      );

    const get = (path: string, cookies: Record<string, string> = {}, headers: Record<string, string> = {}) =>
      fetch(`${base}${path}`, {
        redirect: 'manual',
        headers: { accept: 'application/json', ...headers, cookie: Object.entries(cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ') },
      });

    async function login(sub: string, extra: Record<string, unknown> = {}, tamper?: 'wrong-nonce', headers: Record<string, string> = {}) {
      const begun = await get('/auth/oidc/corp');
      expect(begun.status).to.eq(302);
      const flow = cookiesOf(begun)[flowName];
      const query = idp.authorize(begun.headers.get('location')!, { claims: { sub, ...extra }, ...(tamper ? { tamper } : {}) });
      const done = await get(`/auth/oidc/corp/callback?${new URLSearchParams(query)}`, { [flowName]: flow }, headers);
      return { begun, flow, query, done };
    }

    it('starts the code flow with PKCE S256 at the endpoint discovery found', async () => {
      const res = await get('/auth/oidc/corp');
      expect(res.status).to.eq(302);
      const loc = new URL(res.headers.get('location')!);
      expect(`${loc.origin}${loc.pathname}`).to.eq(idp.discovery.authorization_endpoint);
      expect(loc.searchParams.get('response_type')).to.eq('code');
      expect(loc.searchParams.get('code_challenge_method')).to.eq('S256');
      expect(loc.searchParams.get('redirect_uri')).to.eq(`${base}/auth/oidc/corp/callback`);
      expect(idp.requests.map((r) => r.url)).to.include(idp.discoveryUrl);
      const set = res.headers.getSetCookie().find((l) => l.startsWith(`${flowName}=`))!;
      expect(set).to.match(/HttpOnly/i).and.match(/SameSite=Lax/i);
      expect(res.headers.get('cache-control')).to.eq('no-store');
    });

    it('a user linked in authn_identity logs in and gets a session; the hooks get the mapped claims', async () => {
      await links.link(alice, { provider: 'oidc:corp', subject: 'kc-alice' });
      const { done } = await login('kc-alice', { email: 'alice@example.test', name: 'Alice', groups: ['eng'] });
      expect(done.status).to.eq(303);
      expect(done.headers.get('location')).to.eq('/');
      const signed = cookiesOf(done)[sessionName];
      const rawId = cs.unsign(signed, COOKIE_SECRET);
      expect(rawId, 'a signed session cookie').to.be.a('string');
      expect((await sessions.restore(rawId as string))?.identity).to.deep.eq(alice);
      expect(cookiesOf(done)[flowName]).to.eq('');
      const [identity, external] = HookLog.calls[HookLog.calls.length - 1];
      expect(identity).to.deep.eq(alice);
      expect(external).to.deep.include({ provider: 'oidc:corp', subject: 'kc-alice', email: 'alice@example.test' });
      expect((external.claims as { name?: string; groups?: string[] })).to.deep.include({ name: 'Alice', groups: ['eng'] });
    });

    it('the state is claimed once in authn_nonce: a replayed callback fails', async () => {
      const { flow, query, done } = await login('kc-alice');
      expect(done.status).to.eq(303);
      const again = await get(`/auth/oidc/corp/callback?${new URLSearchParams(query)}`, { [flowName]: flow });
      expect(again.status).to.eq(401);
      const driver = orm.Connections.get('default')!;
      const rows = (await raw(driver, `SELECT k FROM authn_nonce WHERE k LIKE 'oidc-state:%'`)) as { k: string }[];
      expect(rows.length).to.be.greaterThan(0);
    });

    it('a first login of an unlinked subject fails with the login failure answer while JIT is off', async () => {
      const { done } = await login('kc-stranger', { email: 'alice@example.test', email_verified: true });
      expect(done.status).to.eq(401);
      const body = (await done.json()) as { error?: { code?: string } };
      expect(body.error?.code).to.eq('E_AUTH_FAILED');
      expect(cookiesOf(done)[sessionName]).to.eq(undefined);
      expect(await links.find('oidc:corp', 'kc-stranger')).to.eq(null);
    });

    it('a tampered ID token answers the same failure', async () => {
      const { done } = await login('kc-alice', {}, 'wrong-nonce');
      expect(done.status).to.eq(401);
      expect(((await done.json()) as { error?: { code?: string } }).error?.code).to.eq('E_AUTH_FAILED');
    });

    it('a browser lands on a same-site page that moves on, so the Strict session cookie travels', async () => {
      const { done } = await login('kc-alice', {}, undefined, { accept: 'text/html', 'sec-fetch-mode': 'navigate' });
      expect(done.status).to.eq(200);
      expect(done.headers.get('content-type')).to.match(/text\/html/);
      expect(await done.text()).to.contain('http-equiv="refresh"');
      expect(cookiesOf(done)[sessionName]).to.be.a('string');
    });

    it('a browser failure goes to the failure page with no reason', async () => {
      const { done } = await login('kc-stranger', {}, undefined, { accept: 'text/html', 'sec-fetch-mode': 'navigate' });
      expect(done.status).to.eq(303);
      expect(done.headers.get('location')).to.eq('/');
    });

    it('the link routes need the session authn-http restores (N8a): without it they refuse', async () => {
      const res = await fetch(`${base}/auth/oidc/corp/link`, { method: 'POST', redirect: 'manual', headers: { accept: 'application/json' } });
      expect([401, 404]).to.include(res.status);
    });
  });
}

