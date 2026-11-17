import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Injectable } from '@spinajs/di';
import { InvalidOption } from '@spinajs/exceptions';
import { TenantResolver, TenantUnavailable } from '@spinajs/tenancy';
import type { TenantProposal } from '@spinajs/tenancy';
import type { TestApp } from '@spinajs/testing';
import { hostOf, hostPlace, principalOf, resolveTenant, tenantResolvers } from '../src/index.js';
import type { TenantRequestSource } from '../src/index.js';
import { anonymous, seedTenants, source, tenancyHttpApp, user } from './support/source.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const DEFAULT_CHAIN = ['domain', 'subdomain', 'path', 'header', 'principal', 'session'];

/** An application's own resolver: the configuration names it `region`. */
@Injectable(TenantResolver)
class RegionTenantResolver extends TenantResolver {
  public readonly trusted = true;

  public resolve(): TenantProposal | undefined {
    return 'acme';
  }
}

describe('host helpers', () => {
  it('strips the port and lower-cases the host', () => {
    expect(hostOf('Shop.Acme.Example:8443')).to.eq('shop.acme.example');
    expect(hostOf(['a.example', 'b.example'])).to.eq('a.example');
    expect(hostOf('[::1]:3000')).to.eq('[::1]');
    expect(hostOf(undefined)).to.eq(undefined);
    expect(hostOf('')).to.eq(undefined);
  });

  it('places a host against the base domains', () => {
    const bases = ['app.example.com', 'WWW.app.example.com'];

    expect(hostPlace('app.example.com', bases)).to.eq('base');
    expect(hostPlace('www.app.example.com', bases)).to.eq('base');
    expect(hostPlace('acme.app.example.com', bases)).to.deep.eq({ label: 'acme' });
    expect(hostPlace('acme.www.app.example.com', bases)).to.deep.eq({ label: 'acme' });
    expect(hostPlace('a.b.app.example.com', bases)).to.eq('other');
    expect(hostPlace('shop.acme.example', bases)).to.eq('other');
    expect(hostPlace('shop.acme.example', [])).to.eq('other');
  });
});

describe('principalOf', () => {
  it('takes the principal authz established, else the one authn left, and nothing that is not a principal', () => {
    const alice = user('alice');
    const bob = user('bob');

    expect(principalOf({ Principal: alice, AuthnPrincipal: bob })).to.eq(alice);
    expect(principalOf({ AuthnPrincipal: bob })).to.eq(bob);
    expect(principalOf({ Principal: { type: 'user', id: 'eve' }, AuthnPrincipal: 'bob' })).to.eq(undefined);
    expect(principalOf({})).to.eq(undefined);
  });
});

describe('tenant resolvers', () => {
  let app: TestApp;

  const propose = async (name: string, from: Partial<TenantRequestSource>): Promise<TenantProposal | undefined> => (await tenantResolvers([name], app.container))[0].resolve(source(from));

  afterEach(async () => {
    await app?.dispose();
  });

  describe('with base domains', () => {
    beforeEach(async () => {
      app = await tenancyHttpApp({ http: { baseDomains: ['app.example.com'], header: 'X-Org', pathParam: 'org', principalAttribute: 'org', sessionKey: 'org' } });
    });

    it('domain proposes a host that is neither a base domain nor a subdomain of one', async () => {
      expect(await propose('domain', { host: 'shop.acme.example' })).to.deep.eq({ domain: 'shop.acme.example' });
      expect(await propose('domain', { host: 'app.example.com' })).to.eq(undefined);
      expect(await propose('domain', { host: 'acme.app.example.com' })).to.eq(undefined);
      expect(await propose('domain', {})).to.eq(undefined);
    });

    it('subdomain proposes the one label below a base domain as a slug', async () => {
      expect(await propose('subdomain', { host: 'acme-inc.app.example.com' })).to.deep.eq({ slug: 'acme-inc' });
      expect(await propose('subdomain', { host: 'a.b.app.example.com' })).to.eq(undefined);
      expect(await propose('subdomain', { host: 'app.example.com' })).to.eq(undefined);
    });

    it('path proposes the configured route parameter as a slug', async () => {
      expect(await propose('path', { params: { org: 'acme-inc' } })).to.deep.eq({ slug: 'acme-inc' });
      expect(await propose('path', { params: { tenant: 'acme-inc' } })).to.eq(undefined);
    });

    it('header proposes the configured header as a tenant id', async () => {
      expect(await propose('header', { headers: { 'x-org': 'acme' } })).to.eq('acme');
      expect(await propose('header', { headers: { 'x-org': ['acme', 'frozen'] } })).to.eq('acme');
      expect(await propose('header', { headers: { 'x-tenant': 'acme' } })).to.eq(undefined);
    });

    it('principal proposes the attribute of an authenticated principal only', async () => {
      expect(await propose('principal', { principal: user('alice', { org: 'acme' }) })).to.eq('acme');
      expect(await propose('principal', { principal: { ...anonymous, attributes: { org: 'acme' } } })).to.eq(undefined);
      expect(await propose('principal', { principal: user('bob') })).to.eq(undefined);
    });

    it('session proposes the key of the restored session data', async () => {
      expect(await propose('session', { session: new Map<string, unknown>([['org', 'acme']]) })).to.eq('acme');
      expect(await propose('session', { session: new Map<string, unknown>([['org', 7]]) })).to.eq(undefined);
      expect(await propose('session', {})).to.eq(undefined);
    });
  });

  describe('with the defaults', () => {
    beforeEach(async () => {
      app = await tenancyHttpApp();
    });

    it('domain and subdomain propose nothing until base domains are configured', async () => {
      expect(await propose('domain', { host: 'shop.acme.example' })).to.eq(undefined);
      expect(await propose('subdomain', { host: 'acme.app.example.com' })).to.eq(undefined);
    });

    it('reads the route parameter, header, attribute and session key named tenant', async () => {
      expect(await propose('path', { params: { tenant: 'acme-inc' } })).to.deep.eq({ slug: 'acme-inc' });
      expect(await propose('header', { headers: { 'x-tenant': 'acme' } })).to.eq('acme');
      expect(await propose('principal', { principal: user('alice', { tenant: 'acme' }) })).to.eq('acme');
      expect(await propose('session', { session: new Map<string, unknown>([['tenant', 'acme']]) })).to.eq('acme');
    });

    it('trusts every shipped source but the header', async () => {
      const chain = await tenantResolvers(DEFAULT_CHAIN, app.container);

      expect(chain.map((resolver) => resolver.trusted)).to.deep.eq([true, true, true, false, true, true]);
    });

    it('proposes nothing for something that is not a request source', async () => {
      const chain = await tenantResolvers(DEFAULT_CHAIN, app.container);

      expect(chain.map((resolver) => resolver.resolve('acme'))).to.deep.eq([undefined, undefined, undefined, undefined, undefined, undefined]);
    });

    it('finds a resolver by the name it is registered under, and refuses an unknown name', async () => {
      expect((await tenantResolvers(['region'], app.container))[0]).to.be.instanceOf(RegionTenantResolver);
      await expect(tenantResolvers(['domain', 'nope'], app.container)).to.be.rejectedWith(InvalidOption, 'no TenantResolver is registered as NopeTenantResolver');
    });
  });

  describe('resolveTenant', () => {
    const reasonOf = (work: Promise<unknown>): Promise<string> =>
      work.then(
        () => 'resolved',
        (err: unknown) => (err instanceof TenantUnavailable ? err.reason : `unexpected ${String(err)}`),
      );

    const resolve = async (from: Partial<TenantRequestSource>): Promise<string | undefined> => (await resolveTenant(await tenantResolvers(DEFAULT_CHAIN, app.container), source(from), app.container))?.id;

    beforeEach(async () => {
      app = await tenancyHttpApp();
      await seedTenants();
    });

    it('takes the first proposal of the chain', async () => {
      expect(await resolve({ params: { tenant: 'acme-inc' }, headers: { 'x-tenant': 'frozen' }, principal: user('alice', { tenants: ['acme', 'frozen'] }) })).to.eq('acme');
    });

    it('does not fall through to a later resolver when the first proposal is refused', async () => {
      expect(await reasonOf(resolve({ params: { tenant: 'nobody' }, headers: { 'x-tenant': 'acme' }, principal: user('alice', { tenants: ['acme'] }) }))).to.eq('unknown');
    });

    it('honours the header only for an authenticated principal that may enter', async () => {
      expect(await resolve({ headers: { 'x-tenant': 'acme' }, principal: user('alice', { tenants: ['acme'] }) })).to.eq('acme');
      expect(await reasonOf(resolve({ headers: { 'x-tenant': 'acme' }, principal: user('bob') }))).to.eq('forbidden');
      expect(await resolve({ headers: { 'x-tenant': 'acme' }, principal: anonymous })).to.eq(undefined);
      expect(await resolve({ headers: { 'x-tenant': 'acme' } })).to.eq(undefined);
    });

    it('admits an anonymous request on a trusted proposal', async () => {
      expect(await resolve({ params: { tenant: 'acme-inc' }, principal: anonymous })).to.eq('acme');
    });

    it('refuses a tenant that is not active, and answers undefined when nothing names one', async () => {
      expect(await reasonOf(resolve({ params: { tenant: 'frozen' } }))).to.eq('inactive');
      expect(await resolve({})).to.eq(undefined);
    });
  });
});
