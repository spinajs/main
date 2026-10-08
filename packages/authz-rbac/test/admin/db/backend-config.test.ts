import * as chai from 'chai';
import 'mocha';
import { AUTHZ_CONFIGURATION_SCHEMA, AuthzConfigError } from '@spinajs/authz';
import { bootConfiguration, violationPaths } from '@spinajs/authz-testing';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Orm } from '@spinajs/orm';

import { AUTHZ_RBAC_CONFIGURATION_SCHEMA, DbAuthzAdminBackend } from '../../../src/index.js';

const expect = chai.expect;

describe('DbAuthzAdminBackend reads authz.admin.connection through @Config', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function boot(authz: Record<string, unknown>): Promise<IContainer> {
    const booted = await bootConfiguration({ authz }, [AUTHZ_CONFIGURATION_SCHEMA, AUTHZ_RBAC_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
    return booted.child;
  }

  const connectionOf = (backend: DbAuthzAdminBackend) => (backend as unknown as { Connection: string }).Connection;

  it('from the Configuration of the container its options name', async () => {
    expect(connectionOf(new DbAuthzAdminBackend({ container: await boot({ admin: { connection: 'authz' } }) }))).to.equal('authz');
  });

  it('the default connection when the app names none', async () => {
    expect(connectionOf(new DbAuthzAdminBackend({ container: await boot({}) }))).to.equal('default');
  });

  it('fails closed with a named error when an unvalidated configuration leaves the connection unset', async () => {
    // Loading @spinajs/authz registers its schema in the root; DI.clearCache() drops it, as this does.
    const registered = [...(DI.RootContainer.Cache.get('__configurationSchema__', false) as object[])];
    DI.uncache('__configurationSchema__' as never);
    let child: IContainer;
    try {
      child = (await bootConfiguration({ authz: {} }, [])).child;
    } finally {
      for (const s of registered) DI.register(s).asValue('__configurationSchema__');
    }
    children.push(child);
    class FakeOrm {
      Connections = new Map([['default', {}]]);
    }
    child.register(FakeOrm).as(Orm);

    const failure = await (new DbAuthzAdminBackend({ container: child }) as unknown as { connection(): Promise<unknown> }).connection().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).to.be.instanceOf(AuthzConfigError);
    expect((failure as Error).message).to.contain('authz.admin.connection is not set');
  });

  it('refuses an empty authz.rbac.connection at boot; it has no default, so storeConnection can fall back to authz.admin.connection', async () => {
    expect(await violationPaths(boot({ rbac: { connection: '' } }))).to.include('authz.rbac.connection');
    const configuration = (await boot({ admin: { connection: 'authz' } })).get(Configuration);
    expect(configuration?.get('authz.rbac.connection')).to.equal(undefined);
  });
});
