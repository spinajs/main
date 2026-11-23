import 'mocha';
import { expect } from 'chai';
import { BaseSocketController, Command, OnConnect, Payload, SocketConnectionContext, SocketController, SocketException } from '@spinajs/http-socket';
import type { ISocketHandshake, SocketError } from '@spinajs/http-socket';
import type { Principal } from '@spinajs/principal';
import { MemoryTenantRegistry, TenantResolver, currentTenant, tenantRegistry, tenantScope, tenantScopeOf } from '@spinajs/tenancy';
import type { TenantProposal } from '@spinajs/tenancy';
import type { TestApp } from '@spinajs/testing';
import { RequestTenantResolver } from '../src/index.js';
import { TenantSocketContext, socketSource } from '../src/socket.js';
import { anonymous, seedTenants, tenancyHttpApp, user } from './support/source.js';
import { call, connected, handshakeOutcome, handshakeScopes, startSocketApp } from './support/sockets.js';
import type { SocketApp } from './support/sockets.js';

const handshake = (over: Partial<ISocketHandshake> = {}): ISocketHandshake => ({ auth: {}, headers: {}, cookies: {}, address: '127.0.0.1', peerAddress: '127.0.0.1', url: '/', query: {}, secure: false, issuedAt: 0, ...over });

const alice = user('alice', { tenants: ['acme'] });

const connectHooks: Array<string | null> = [];

const counted = { runs: 0 };

/** Fails to build `failures` times, then proposes acme. */
class FlakyTenantResolver extends RequestTenantResolver {
  public static failures = 0;

  constructor() {
    super();
    if (FlakyTenantResolver.failures > 0) {
      FlakyTenantResolver.failures -= 1;
      throw new Error('resolver store down');
    }
  }

  protected propose(): TenantProposal {
    return 'acme';
  }
}

@SocketController('tenant')
export class TenantProbeSocket extends BaseSocketController {
  @OnConnect()
  public onConnect(): Promise<void> {
    connectHooks.push(currentTenant()?.id ?? null);
    return Promise.resolve();
  }

  /** The tenant before and after a wait, so calls of two connections interleave. */
  @Command('where')
  public async where(@Payload() wait: unknown): Promise<Array<string | null>> {
    const before = currentTenant()?.id ?? null;
    await new Promise((resolve) => setTimeout(resolve, typeof wait === 'number' ? wait : 0));
    return [before, tenantScope()?.kind ?? null, currentTenant()?.id ?? null];
  }

  @Command('count', { idempotent: true })
  public count(): Promise<[string | null, number]> {
    return Promise.resolve([currentTenant()?.id ?? null, ++counted.runs]);
  }
}

describe('tenant of a socket connection', () => {
  let app: TestApp;

  const establish = async (shake: ISocketHandshake, principal: Principal): Promise<Readonly<Record<string, unknown>>> => (await app.resolve(TenantSocketContext)).establish(shake, principal);

  const refusalOf = (work: Promise<unknown>): Promise<string> =>
    work.then(
      () => 'connected',
      (err: unknown) => (err instanceof SocketException ? `${err.code}: ${err.message}` : `unexpected ${String(err)}`),
    );

  afterEach(async () => {
    await app?.dispose();
  });

  it('registers as a SocketConnectionContext', async () => {
    app = await tenancyHttpApp();

    expect(app.container.getRegisteredNames(SocketConnectionContext)).to.include('TenantSocketContext');
  });

  it('reads auth.tenant as the untrusted header, and the host without its port', () => {
    const source = socketSource(handshake({ auth: { tenant: 'acme' }, headers: { host: 'Acme.App.Example.com:443', 'x-tenant': 'frozen' } }), alice, 'X-Tenant');

    expect(source.headers['x-tenant']).to.eq('acme');
    expect(source.host).to.eq('acme.app.example.com');
    expect(source.params).to.deep.eq({});
    expect(source.principal).to.eq(alice);
  });

  it('reads X-Forwarded-Host only from a peer the proxy trust trusts', () => {
    const shake = handshake({ headers: { host: '127.0.0.1:80', 'x-forwarded-host': 'acme-inc.app.example.com' } });

    expect(socketSource(shake, alice, 'x-tenant').host).to.eq('127.0.0.1');
    expect(socketSource(shake, alice, 'x-tenant', { hops: 1 }).host).to.eq('acme-inc.app.example.com');
  });

  describe('with tenants', () => {
    beforeEach(async () => {
      app = await tenancyHttpApp({ http: { baseDomains: ['app.example.com'] } });
      await seedTenants();
    });

    it('gives the connection the tenant an authenticated member names', async () => {
      expect(await establish(handshake({ auth: { tenant: 'acme' } }), alice)).to.deep.eq({ Tenant: { kind: 'tenant', tenant: { id: 'acme' } } });
    });

    it('takes the tenant of the subdomain for an anonymous connection', async () => {
      expect(await establish(handshake({ headers: { host: 'acme-inc.app.example.com' } }), anonymous)).to.deep.eq({ Tenant: { kind: 'tenant', tenant: { id: 'acme' } } });
    });

    it('connects with no tenant scope when the handshake names none, or names one without credentials', async () => {
      expect(await establish(handshake(), alice)).to.deep.eq({});
      expect(await establish(handshake({ auth: { tenant: 'acme' } }), anonymous)).to.deep.eq({});
    });

    it('refuses a handshake that names an unknown, a suspended or a forbidden tenant', async () => {
      expect(await refusalOf(establish(handshake({ auth: { tenant: 'nobody' } }), alice))).to.eq('not_found: tenant not available');
      expect(await refusalOf(establish(handshake({ auth: { tenant: 'frozen' } }), alice))).to.eq('not_found: tenant not available');
      expect(await refusalOf(establish(handshake({ auth: { tenant: 'acme' } }), user('bob')))).to.eq('not_found: tenant not available');
    });

    it('refuses the connection when the registry fails, instead of connecting without a scope', async () => {
      const registry = (await tenantRegistry()).inner;
      if (!(registry instanceof MemoryTenantRegistry)) throw new Error('expected the memory registry');
      registry.get = () => Promise.reject(new Error('registry down'));

      expect(await refusalOf(establish(handshake({ auth: { tenant: 'acme' } }), alice))).to.eq('unexpected Error: registry down');
    });
  });

  it('looks the resolvers up again at the next handshake after the lookup failed', async () => {
    app = await tenancyHttpApp({ http: { resolvers: ['flaky'] } });
    await seedTenants();
    app.container.register(FlakyTenantResolver).as(TenantResolver);
    FlakyTenantResolver.failures = 1;

    expect(await refusalOf(establish(handshake(), alice))).to.contain('resolver store down');
    expect(await establish(handshake(), alice)).to.deep.eq({ Tenant: { kind: 'tenant', tenant: { id: 'acme' } } });
  });

  it('refuses with forbidden when tenancy.http.unknownTenant is 403', async () => {
    app = await tenancyHttpApp({ http: { unknownTenant: 403 } });

    expect(await refusalOf(establish(handshake({ auth: { tenant: 'nobody' } }), alice))).to.eq('forbidden: tenant not available');
  });
});

describe('tenant of a socket connection, over a real handshake', function () {
  this.timeout(30000);

  let sockets: SocketApp;

  const open = (auth: Record<string, unknown> = {}, headers: Record<string, string> = {}) => connected(sockets.connect(auth, headers));

  describe('behind a trusted proxy', () => {
    let registry: MemoryTenantRegistry;

    beforeEach(async () => {
      sockets = await startSocketApp('loopback', { http: { baseDomains: ['127.0.0.1', 'app.example.com'] } });
      registry = await seedTenants();
      registry.add({ id: 'globex' });
      connectHooks.length = 0;
      handshakeScopes.length = 0;
    });

    afterEach(async () => {
      await sockets.close();
    });

    it('runs the calls of two connections of two tenants in their own scopes, and leaks none of them', async () => {
      const acme = await open({ user: 'alice', tenant: 'acme' });
      const globex = await open({ user: 'carol', tenant: 'globex' });
      const none = await open({ user: 'bob' });

      const answers = await Promise.all([call(acme, 'tenant.where', 60), call(globex, 'tenant.where', 20), call(none, 'tenant.where', 40), call(acme, 'tenant.where', 0), call(globex, 'tenant.where', 50)]);

      expect(answers).to.deep.eq([
        ['acme', 'tenant', 'acme'],
        ['globex', 'tenant', 'globex'],
        [null, null, null],
        ['acme', 'tenant', 'acme'],
        ['globex', 'tenant', 'globex'],
      ]);
      expect(connectHooks).to.have.members(['acme', 'globex', null]);
      // Each handshake ran in the server's ambient context, which no earlier connection's tenant reached.
      expect(handshakeScopes).to.deep.eq([null, null, null]);
      expect(tenantScope()).to.eq(undefined);
    });

    it("runs one principal's idempotency key once in each tenant of one client, and replays each tenant its own reply", async () => {
      counted.runs = 0;
      const acme = await open({ user: 'erin', tenant: 'acme', clientId: 'erin-app' });
      const globex = await open({ user: 'erin', tenant: 'globex', clientId: 'erin-app' });

      expect(await call(acme, 'tenant.count', undefined, 'k-1')).to.deep.eq(['acme', 1]);
      expect(await call(globex, 'tenant.count', undefined, 'k-1')).to.deep.eq(['globex', 2]);
      expect(await call(acme, 'tenant.count', undefined, 'k-1')).to.deep.eq(['acme', 1]);
      expect(await call(globex, 'tenant.count', undefined, 'k-1')).to.deep.eq(['globex', 2]);
    });

    it('runs an anonymous idempotency key once in each tenant of one client', async () => {
      counted.runs = 0;
      const acme = await open({ clientId: 'kiosk' }, { 'x-forwarded-host': 'acme-inc.app.example.com' });
      const globex = await open({ clientId: 'kiosk' }, { 'x-forwarded-host': 'globex.app.example.com' });

      expect(await call(acme, 'tenant.count', undefined, 'k-1')).to.deep.eq(['acme', 1]);
      expect(await call(globex, 'tenant.count', undefined, 'k-1')).to.deep.eq(['globex', 2]);
      expect(await call(globex, 'tenant.count', undefined, 'k-1')).to.deep.eq(['globex', 2]);
    });

    it('takes the tenant of the forwarded host from a trusted peer', async () => {
      const socket = await open({}, { 'x-forwarded-host': 'acme-inc.app.example.com' });

      expect(await call(socket, 'tenant.where')).to.deep.eq(['acme', 'tenant', 'acme']);
    });

    it('answers unknown, suspended and forbidden tenants alike, and never falls through to the next resolver', async () => {
      const outcomes = await Promise.all([
        handshakeOutcome(sockets.connect({ user: 'alice', tenant: 'nobody' })),
        handshakeOutcome(sockets.connect({ user: 'alice', tenant: 'frozen' })),
        handshakeOutcome(sockets.connect({ user: 'bob', tenant: 'acme' })),
        // alice's principal attribute names acme, the resolver after the header
        handshakeOutcome(sockets.connect({ user: 'alice', tenant: 'globex' })),
      ]);

      const refusal: SocketError = { code: 'not_found', message: 'tenant not available', retryable: false };
      expect(outcomes).to.deep.eq([refusal, refusal, refusal, refusal]);
    });

    it('keeps the scope of an open connection when its tenant is suspended; a new handshake is refused', async () => {
      const socket = await open({ user: 'alice', tenant: 'acme' });
      registry.set('acme', { state: 'suspended' });

      expect(await call(socket, 'tenant.where')).to.deep.eq(['acme', 'tenant', 'acme']);
      expect(await handshakeOutcome(sockets.connect({ user: 'alice', tenant: 'acme' }))).to.include({ code: 'not_found' });
    });
  });

  describe('behind an untrusted peer, in a server whose ambient context is inside a tenant scope', () => {
    before(async () => {
      sockets = await startSocketApp(undefined, { http: { baseDomains: ['127.0.0.1', 'app.example.com'] } }, tenantScopeOf('acme'));
      await seedTenants();
      handshakeScopes.length = 0;
    });

    after(async () => {
      await sockets.close();
    });

    it('ignores the forwarded host and runs a connection without a tenant with no scope', async () => {
      const socket = await open({ user: 'bob' }, { 'x-forwarded-host': 'acme-inc.app.example.com' });

      expect(handshakeScopes).to.deep.eq([{ kind: 'tenant', tenant: { id: 'acme' } }]);
      expect(await call(socket, 'tenant.where')).to.deep.eq([null, null, null]);
    });
  });
});
