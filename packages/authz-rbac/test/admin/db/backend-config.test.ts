import * as chai from 'chai';
import 'mocha';
import { AuthzConfigError } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Orm } from '@spinajs/orm';

import { DbAuthzAdminBackend } from '../../../src/index.js';

const expect = chai.expect;

describe('DbAuthzAdminBackend opens its transactions on the connection db.Aliases.authz names', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  const withConnections = (connections: [string, unknown][]): IContainer => {
    const child = DI.child();
    children.push(child);
    class FakeOrm {
      Connections = new Map(connections);
    }
    child.register(FakeOrm).as(Orm);
    return child;
  };

  const connectionOf = (container: IContainer) =>
    (new DbAuthzAdminBackend({ container }) as unknown as { connection(): Promise<unknown> }).connection().then(
      (driver) => driver,
      (e: unknown) => e,
    );

  it('the driver stored under the alias', async () => {
    const authz = { Options: { Name: 'main' } };
    expect(await connectionOf(withConnections([['default', {}], ['authz', authz]]))).to.equal(authz);
  });

  it('a named error when no connection answers to the alias', async () => {
    const failure = await connectionOf(withConnections([['default', {}]]));
    expect(failure).to.be.instanceOf(AuthzConfigError);
    expect((failure as Error).message).to.contain('db.Aliases.authz').and.contain('connections: default');
  });
});
