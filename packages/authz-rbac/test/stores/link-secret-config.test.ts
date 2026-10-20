import * as chai from 'chai';
import 'mocha';
import { bootConfiguration, violationPaths } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';

import { AUTHZ_RBAC_CONFIGURATION_SCHEMA, DbLinkStore } from '../../src/index.js';

const expect = chai.expect;

describe('DbLinkStore reads authz.rbac.links.secret through @Config', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  const boot = (secret: string) => bootConfiguration({ authz: { rbac: { links: { secret } } } }, [AUTHZ_RBAC_CONFIGURATION_SCHEMA]);

  it('from the Configuration of the container it is built for', async () => {
    const { child } = await boot('s'.repeat(32));
    children.push(child);

    expect((new DbLinkStore(child) as unknown as { Secret: string }).Secret).to.equal('s'.repeat(32));
  });

  it('a secret shorter than 32 characters fails the boot', async () => {
    expect(await violationPaths(boot('x'.repeat(31)))).to.include('authz.rbac.links.secret');
  });
});
