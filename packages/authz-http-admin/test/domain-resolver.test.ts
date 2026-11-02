import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { AuthzDomains } from '@spinajs/authz';
import { ForbiddenResponse } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { AuthzDomainResolver, UnknownAuthzDomain } from '@spinajs/authz-http';
import { StaticModel, testHost } from '@spinajs/authz-testing';

import { AuthzAdminController } from '../src/controllers/AuthzAdminController.js';
import { AuthzAdminDomainArg, adminInputAnswer } from '../src/routes/index.js';

const BASE = 'admin-base';
const TENANT = 'admin-tenant';

/** Header `x-tenant` names the domain. */
class TenantResolver extends AuthzDomainResolver {
  public resolve(req: Request, fallback: string): string {
    const tenant = req.headers['x-tenant'];
    return typeof tenant === 'string' ? tenant : fallback;
  }
}

/** A child domain of root holding one StaticModel, booted. */
async function createDomain(name: string): Promise<() => Promise<void>> {
  const cfg = testHost.config();
  cfg.set(['authz', 'domains', name], { permissions: {}, combine: { default: { algorithm: 'deny-overrides', models: ['m1'] } }, cache: { maxEntries: 0 } });
  const domains = (await testHost.domains()) as AuthzDomains;
  const container = domains.create(name, 'root');
  testHost.activate(container, name, new StaticModel({ name: 'm1' }));
  await domains.service(name);
  return async () => {
    await container.dispose();
    cfg.unset(['authz', 'domains', name]);
  };
}

type Guarded = { guarded(fn: (admin: unknown) => Promise<unknown>, domain?: string): Promise<unknown> };

const requestOf = (tenant?: string) => ({ headers: tenant === undefined ? {} : { 'x-tenant': tenant } }) as unknown as Request;

describe('AuthzAdminController with an AuthzDomainResolver (ARCH-2)', function () {
  this.timeout(30000);

  let disposers: (() => Promise<void>)[];
  let controller: Guarded;
  let arg: AuthzAdminDomainArg;

  const adminOf = async (name: string) => (await DI.resolve<AuthzDomains>(AuthzDomains)).service(name).then((s) => s.admin());
  const domainOf = async (req: Request): Promise<string> => (await arg.extract({ Payload: {} }, [], {} as never, req)).Args;
  const adminInUse = async (req: Request) => {
    let used: unknown;
    await controller.guarded(async (admin) => (used = admin), await domainOf(req));
    return used;
  };

  before(async () => {
    await testHost.installHost();
    testHost.config().set(['authz', 'http', 'admin', 'domain'], BASE);
    disposers = [await createDomain(BASE), await createDomain(TENANT)];
    DI.register(TenantResolver).as(AuthzDomainResolver);
    DI.uncache(AuthzDomainResolver);
    controller = (await DI.resolve(AuthzAdminController)) as unknown as Guarded;
    arg = await DI.resolve(AuthzAdminDomainArg);
  });

  after(async () => {
    DI.unregister(TenantResolver as Class<unknown>);
    DI.uncache(TenantResolver);
    DI.uncache(AuthzDomainResolver);
    DI.uncache(AuthzAdminController);
    for (const dispose of disposers ?? []) await dispose();
    await testHost.uninstallHost();
  });

  it('runs a route on the AuthzAdmin of the domain the resolver names', async () => {
    expect(await adminInUse(requestOf(TENANT))).to.equal(await adminOf(TENANT));
  });

  it('falls back to authz.http.admin.domain when the resolver returns its fallback', async () => {
    expect(await adminInUse(requestOf())).to.equal(await adminOf(BASE));
  });

  it('answers 403 unknown_domain for a domain no live domain bears, before the route runs', async () => {
    const refused = await domainOf(requestOf('nope')).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(refused).to.be.instanceOf(UnknownAuthzDomain);
    const res = adminInputAnswer(refused as Error);
    expect(res).to.be.instanceOf(ForbiddenResponse);
    expect((res as unknown as { responseData: { error: { code: string } } }).responseData.error.code).to.eq('unknown_domain');
  });
});
