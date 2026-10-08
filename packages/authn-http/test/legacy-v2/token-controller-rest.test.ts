import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { CONTROLLED_DESCRIPTOR_SYMBOL, Controllers, HttpServer, IControllerDescriptor } from '@spinajs/http';
import { fsService } from '@spinajs/fs';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider } from '@spinajs/users';
import { ACL_CONTROLLER_DESCRIPTOR } from '../../src/decorators.js';
import { IRbacDescriptor } from '../../src/interfaces.js';
import { RbacPolicy } from '../../src/policies/RbacPolicy.js';

import { req, restoreHttpErrorMap, useTestConfiguration } from '../token-common.js';
import { AccessTokenController } from '../../src/token/controllers/AccessTokenController.js';
import { NoTokenAuthPolicy } from '../../src/token/policies/NoTokenAuthPolicy.js';
import { NoImpersonationPolicy } from '../../src/token/policies/NoImpersonationPolicy.js';
import '@spinajs/authn-token';

/**
 * The self-service token API over a real http server. The rows that need a
 * user's roles are in `legacy-v2/token-controller.test.ts`: since C1 the 2.x
 * stack reads no roles for a stored user (LEDGER, N8a task 9).
 *
 * Since N8c the controller-scope group below is fed by LegacyStorageBridge's
 * `TokenAuth` and `Impersonator` markers (`test/v3/legacy-bridge.test.ts`): it
 * is what keeps a token from minting a token here until N8b replaces it.
 */
describe('AccessTokenController', function () {
  this.timeout(25000);

  let server: HttpServer;

  before(async () => {
    DI.setESMModuleSupport();

    // Sibling suites clear the container cache in their `after()`, taking the
    // exception -> response map with it; without this every rejection asserted
    // below would arrive as a 500. See `restoreHttpErrorMap` in `common.ts`.
    restoreHttpErrorMap();

    // Not a plain `DI.register(...).as(Configuration)` - see the helper for why
    // that silently loses to a db-only suite's configuration.
    useTestConfiguration();
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    DI.register(SimpleDbAuthProvider).as(AuthProvider);

    // rbac wires its AccessControl instance and user factories from a
    // bootstrapper; nothing runs bootstrappers for us outside a real app.
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    // order matters - @Config getters fire during fs / controller resolution,
    // and the controller cache reads its own `__fs_controller_cache__` provider
    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Orm);
    await DI.resolve(Controllers);

    server = await DI.resolve(HttpServer);

    // AWAITED, both here and in after(): `start()` binds the port inside a
    // promise ( `http/src/server.ts` ) and `stop()` is a promise too, so an
    // un-awaited pair lets a request go out before the listener exists and lets
    // the next suite start while this one still holds 8889.
    //
    // The port this actually binds comes from the configuration registered in
    // `useTestConfiguration()` above - NOT from a plain `DI.register(...)`. See
    // that helper's docblock: registration de-duplicates by type name, so a
    // db-only suite's configuration stays the winner and this server would
    // silently bind the framework default 1337 while every request here goes to
    // 8889.
    await server.start();
  });

  after(async () => {
    await server.stop();
    DI.clearCache();
  });

  it('rejects anonymous access', async () => {
    const res = await req().get('user/tokens');
    expect(res.status).to.be.oneOf([401, 403]);
  });

  /**
   * Structural guard on the decorator layout.
   *
   * The impersonation test in `legacy-v2/` would still pass without `NoTokenAuthPolicy`,
   * because `RbacPolicy` happens to demand a session too - so it cannot tell a
   * deliberate guard from a lucky one. This asserts the layout itself: ONE
   * controller-scope group holding BOTH guards ( `createPolicyGate` ANDs the
   * controller scope with the route scope, ANDs the members of a group, and a
   * lone group cannot be ORed away ), plus RbacPolicy on every route from
   * `@Permission`.
   */
  it('guards every route with both controller-scope policies in ONE mandatory group', () => {
    // stored on the PROTOTYPE - `Controller()` writes to `target.prototype`
    const descriptor: IControllerDescriptor = Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, AccessTokenController.prototype);

    expect(descriptor.Policies, 'a second controller-scope group would be ORed with this one, making both optional').to.have.length(1);
    // ONE group, BOTH members - split across two @Policy() calls they would be
    // ORed and neither would remain a requirement
    expect(descriptor.Policies[0].map((p) => p.Type)).to.have.members([NoTokenAuthPolicy, NoImpersonationPolicy]);

    expect([...descriptor.Routes.keys()]).to.have.members(['roles', 'profiles', 'list', 'create', 'delete', 'grantRole', 'revokeRole']);
    for (const [name, route] of descriptor.Routes) {
      const types = route.Policies.flat().map((p) => p.Type);
      expect(types, `route ${String(name)} must carry the rbac permission check`).to.include(RbacPolicy);
    }

    // The permission each route DEMANDS, not merely that it demands one.
    // `RbacPolicy` falls back to the controller-level permission for any route
    // it finds no entry for, and the controller default is `readOwn` - so a
    // route that lost its `@Permission` line would quietly downgrade a write to
    // a read check while still passing every assertion above.
    const acl: IRbacDescriptor = Reflect.getMetadata(ACL_CONTROLLER_DESCRIPTOR, AccessTokenController.prototype);
    expect(acl.Resource).to.equal('user.tokens');

    const expected: Record<string, string[]> = {
      roles: ['readOwn'],
      profiles: ['readOwn'],
      list: ['readOwn'],
      create: ['createOwn'],
      delete: ['deleteOwn'],
      grantRole: ['updateOwn'],
      revokeRole: ['updateOwn'],
    };

    for (const [name, permission] of Object.entries(expected)) {
      expect(acl.Routes.get(name)?.Permission, `route ${name} declares the wrong permission`).to.deep.equal(permission);
    }

    // every OWN scope, nothing broader: this controller is self-service only
    for (const [name, route] of acl.Routes) {
      for (const p of route.Permission ?? []) {
        expect(p, `route ${String(name)} declares a non-own permission`).to.match(/Own$/);
      }
    }
  });
});
