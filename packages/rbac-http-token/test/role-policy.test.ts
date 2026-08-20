import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { User } from '@spinajs/rbac';

import { OwnRolesTokenRolePolicy, _role_excluded } from '../src/role-policy.js';
import { DbTestConfiguration } from './db-common.js';

/**
 * `UserBase`'s constructor resolves `rbac.defaultRole` through `_cfg`, resolves
 * `'AccessControl'` from DI, and - because the model carries relations -
 * touches its orm driver's container for the `'default'` connection
 * ( `rbac/src/models/User.ts`, `orm/src/model.ts` ). All three are wired off a
 * resolved `Configuration` and a bootstrapped `Orm`, so a bare `new User(...)`
 * throws without this setup even though this suite never queries the database.
 * Mirrors the `before`/`after` in `./model.test.ts`.
 */
describe('access token role policy - defaults', () => {
  before(async () => {
    DI.setESMModuleSupport();

    DI.register(DbTestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Configuration);
    await DI.resolve(Orm);
  });

  after(() => {
    DI.clearCache();
  });

  describe('OwnRolesTokenRolePolicy', () => {
    it('allows exactly the roles the owner holds', async () => {
      const policy = new OwnRolesTokenRolePolicy();
      const owner = new User({ Role: ['user', 'admin'] });

      expect(await policy.allowedRoles(owner)).to.deep.equal(['user', 'admin']);
    });

    it('allows nothing for an owner with no roles', async () => {
      const policy = new OwnRolesTokenRolePolicy();

      // `new User({ Role: [] })` would not do: `UserBase`'s constructor runs an
      // empty `Role` through `_default([_cfg('rbac.defaultRole')()])`, which
      // substitutes the configured default role ( `rbac/src/models/User.ts` ) -
      // an empty array never survives construction. Assigning directly after
      // construction is how this scenario ( genuinely zero roles ) is reached.
      const owner = new User({ Role: ['user'] });
      owner.Role = [];

      expect(await policy.allowedRoles(owner)).to.deep.equal([]);
    });
  });

  describe('_role_excluded', () => {
    it('matches an exact name', () => {
      expect(_role_excluded('route.home', ['route.home'])).to.equal(true);
      expect(_role_excluded('route.admin', ['route.home'])).to.equal(false);
    });

    it('matches a prefix pattern and everything under it', () => {
      expect(_role_excluded('route.home', ['route.*'])).to.equal(true);
      expect(_role_excluded('route.admin.users', ['route.*'])).to.equal(true);
    });

    it('does not treat the prefix as a bare string match', () => {
      // 'routes.read' starts with the letters of the pattern's prefix but is
      // not under it - the dot is part of the boundary.
      expect(_role_excluded('routes.read', ['route.*'])).to.equal(false);
    });

    it('excludes nothing when no patterns are given', () => {
      expect(_role_excluded('route.home', [])).to.equal(false);
    });
  });
});
