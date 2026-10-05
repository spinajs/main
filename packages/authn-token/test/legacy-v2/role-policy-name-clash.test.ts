import 'mocha';
import { expect } from 'chai';
import { AccessControl } from 'accesscontrol';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration, service } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider, User } from '@spinajs/users';
// authz-rbac declares its own `OwnRolesTokenRolePolicy`; DI keys classes by name
import { OwnRolesTokenRolePolicy as RbacOwnRolesTokenRolePolicy } from '@spinajs/authz-rbac';

import { DbTestConfiguration } from '../db-common.js';
import { _allowed_profiles, _allowed_roles } from '../../src/legacy/actions.js';
import { AccessTokenRolePolicy } from '../../src/legacy/interfaces.js';
import { LegacyOwnRolesTokenRolePolicy } from '../../src/legacy/role-policy.js';
import '../../src/generator.js';

describe('legacy token role policy next to authz-rbac', function () {
  this.timeout(15000);

  before(async () => {
    DI.setESMModuleSupport();

    DI.register(DbTestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    DI.register(SimpleDbAuthProvider).as(AuthProvider);

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Configuration);
  });

  after(async () => {
    DI.clearCache();
  });

  it('the two classes are distinct and carry distinct names', () => {
    expect(LegacyOwnRolesTokenRolePolicy.name).to.not.equal(RbacOwnRolesTokenRolePolicy.name);
  });

  it('the 2.x actions resolve the legacy policy, not the one of authz-rbac', async () => {
    const ac = DI.get<AccessControl>('AccessControl')!;
    ac.grant('z1role').readOwn('z1resource');

    // `users.Role` is gone from the 3.0 schema, so the owner is an in-memory stand-in
    const owner = { Id: 1, Role: ['z1role', 'unknown'] } as unknown as User;

    // `createToken` and `validateToken` both go through these two
    expect(await _allowed_roles(owner)).to.deep.equal(['z1role']);
    expect(await _allowed_profiles(owner)).to.deep.equal([]);

    const policy = await service<AccessTokenRolePolicy>('rbac.token.rolePolicy', AccessTokenRolePolicy);
    expect(policy).to.be.instanceOf(LegacyOwnRolesTokenRolePolicy);
  });
});
