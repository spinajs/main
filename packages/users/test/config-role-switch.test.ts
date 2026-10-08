import 'mocha';
import { expect } from 'chai';
import { AUTHZ_CONFIGURATION_SCHEMA } from '@spinajs/authz';
import { CONFIGURATION_CONTAINER_KEY } from '@spinajs/configuration';

import { RbacRoleSource, ROLE_SWITCH_PASSWORD_KEY } from '../src/index.js';
import { bootChild, disposeChildren, violationPaths } from './support/child-config.js';

const configured = (value: unknown) => ({ authz: { principals: { roleSwitch: { requirePassword: value } } } });
const read = (instance: object, property: string): unknown => (instance as unknown as Record<string, unknown>)[property];

describe('authz.principals.roleSwitch.requirePassword', () => {
  afterEach(disposeChildren);

  for (const bad of ['support', [''], [{}], [['support']]]) {
    it(`fails the boot for ${JSON.stringify(bad)}, naming the key`, async () => {
      expect(await violationPaths(configured(bad), AUTHZ_CONFIGURATION_SCHEMA)).to.include(ROLE_SWITCH_PASSWORD_KEY);
    });
  }

  for (const good of [[], ['support'], ['support', 'member'], null]) {
    it(`boots with ${JSON.stringify(good)}`, async () => {
      const { config } = await bootChild(configured(good), AUTHZ_CONFIGURATION_SCHEMA);

      expect(config.get(ROLE_SWITCH_PASSWORD_KEY)).to.deep.equal(good);
    });
  }

  it('RbacRoleSource reads the 3.0 and the 2.x key from the container that builds it', async () => {
    const { child } = await bootChild({ authz: { principals: { roleSwitch: { requirePassword: ['support'] } } }, rbac: { roleSwitch: { requirePassword: ['member'] } } }, AUTHZ_CONFIGURATION_SCHEMA);
    // A root singleton: DI hands it the root container, so the test hands it the child's.
    const source = new RbacRoleSource();
    (source as unknown as Record<string, unknown>)[CONFIGURATION_CONTAINER_KEY] = child;

    expect(read(source, 'RequirePassword')).to.deep.equal(['support']);
    expect(read(source, 'LegacyRequirePassword')).to.deep.equal(['member']);
  });
});
