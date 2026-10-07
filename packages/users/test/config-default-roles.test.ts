import 'mocha';
import { expect } from 'chai';
import { PerChildInstance } from '@spinajs/di';
import { AUTHZ_RBAC_CONFIGURATION_SCHEMA } from '@spinajs/authz-rbac';

import { DEFAULT_ROLES_KEY } from '../src/role-assignments.js';
import { DefaultRolesBootCheck } from '../src/index.js';
import { bootChild, disposeChildren, violationPaths } from './support/child-config.js';

// The check itself is a root singleton (it reads the root's stores); a per-child subclass shows the property follows the resolving container.
@PerChildInstance()
class ChildDefaultRolesBootCheck extends DefaultRolesBootCheck {}

const configured = (value: unknown) => ({ authz: { rbac: { defaultRoles: value } } });

describe('authz.rbac.defaultRoles', () => {
  afterEach(disposeChildren);

  const bad: Array<[string, unknown, string]> = [
    ['a string', 'user', DEFAULT_ROLES_KEY],
    ['an empty role name', ['user', ''], `${DEFAULT_ROLES_KEY}.1`],
    ['a blank role name', ['   '], `${DEFAULT_ROLES_KEY}.0`],
    ['a role name with leading whitespace', [' user'], `${DEFAULT_ROLES_KEY}.0`],
    ['a role name with trailing whitespace', ['user '], `${DEFAULT_ROLES_KEY}.0`],
    ['a role name that is not a string', [{}], `${DEFAULT_ROLES_KEY}.0`],
  ];

  for (const [label, value, path] of bad) {
    it(`fails the boot for ${label}, naming the bad key`, async () => {
      expect(await violationPaths(configured(value), AUTHZ_RBAC_CONFIGURATION_SCHEMA)).to.include(path);
    });
  }

  it('boots with a list of role names and with none at all', async () => {
    expect((await bootChild(configured(['user', 'editor']), AUTHZ_RBAC_CONFIGURATION_SCHEMA)).config.get(DEFAULT_ROLES_KEY)).to.deep.equal(['user', 'editor']);
    expect((await bootChild({}, AUTHZ_RBAC_CONFIGURATION_SCHEMA)).config.get(DEFAULT_ROLES_KEY)).to.equal(undefined);
  });

  it('DefaultRolesBootCheck reads them from the container that builds it', async () => {
    const { child } = await bootChild(configured(['user']), AUTHZ_RBAC_CONFIGURATION_SCHEMA);
    const check = await child.resolve(ChildDefaultRolesBootCheck);

    expect((check as unknown as Record<string, unknown>).DefaultRoles).to.deep.equal(['user']);
  });
});
