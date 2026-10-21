import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { AuthorizationModel, AuthzDomains } from '@spinajs/authz';
import { ForbiddenResponse } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { AuthzDomainResolver } from '@spinajs/authz-http';
import { StaticModel, testHost } from '@spinajs/authz-testing';

import { AuthzAdminController } from '../src/controllers/AuthzAdminController.js';

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
  container.register(testHost.instance(new StaticModel({ name: 'm1' }))).as(AuthorizationModel);
  await domains.service(name);
  return async () => {
    await container.dispose();
    cfg.unset(['authz', 'domains', name]);
  };
}

type Guarded = { guarded(fn: (admin: unknown) => Promise<unknown>, req?: Request): Promise<unknown> };

const requestOf = (tenant?: string) => ({ headers: tenant === undefined ? {} : { 'x-tenant': tenant } }) as unknown as Request;

describe('AuthzAdminController with an AuthzDomainResolver (ARCH-2)', function () {
  this.timeout(30000);

  let disposers: (() => Promise<void>)[];
  let controller: Guarded;

  const adminOf = async (name: string) => (await DI.resolve<AuthzDomains>(AuthzDomains)).service(name).then((s) => s.admin());
  const adminInUse = async (req?: Request) => {
    let used: unknown;
    await controller.guarded(async (admin) => (used = admin), req);
    return used;
  };

  before(async () => {
    await testHost.installHost();
    testHost.config().set(['authz', 'http', 'admin', 'domain'], BASE);
    disposers = [await createDomain(BASE), await createDomain(TENANT)];
    DI.register(TenantResolver).as(AuthzDomainResolver);
    DI.uncache(AuthzDomainResolver);
    controller = (await DI.resolve(AuthzAdminController)) as unknown as Guarded;
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

  it('answers 403 unknown_domain for a domain no live domain bears, and runs nothing', async () => {
    let ran = false;
    const res = await controller.guarded(async () => {
      ran = true;
      return undefined;
    }, requestOf('nope'));

    expect(ran).to.eq(false);
    expect(res).to.be.instanceOf(ForbiddenResponse);
    expect((res as { responseData: { error: { code: string } } }).responseData.error.code).to.eq('unknown_domain');
  });
});
