import 'mocha';
import { expect } from 'chai';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { CONTROLLED_DESCRIPTOR_SYMBOL, IControllerDescriptor, IRoute, RouteType } from '@spinajs/http';
import { ACL_CONTROLLER_DESCRIPTOR } from '@spinajs/rbac-http';
import type { IRbacDescriptor } from '@spinajs/rbac-http';
import { DataValidator } from '@spinajs/validation';

import { CreateUserDto, UpdateUserDto, Users } from '../src/controllers/Users/Users.js';
import { Roles } from '../src/controllers/Users/Roles.js';
import { Security } from '../src/controllers/Users/Security.js';
import { Profile } from '../src/controllers/Users/Profile.js';

import { TestConfiguration } from './common.js';

/**
 * The layers the handler-level suite cannot see.
 *
 * `users-controller.test.ts` calls handlers directly, which is the right way to
 * test what they DO — but it walks straight past the two things that decide
 * whether a request ever reaches them: the policies attached to the route and
 * the JSON schema applied to the body. Both have already failed silently once:
 * two read routes shipped with no permission decorator at all ( so any logged-in
 * user could read any account ), and PATCH shared the creation schema ( so every
 * documented partial update was rejected ).
 *
 * These assertions read the descriptors the http and rbac decorators produce,
 * and run the DTO schemas through the real validator. No server is started —
 * this is a contract test, not an end-to-end one.
 */

const controllerDescriptor = (instance: object): IControllerDescriptor => Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, instance) as IControllerDescriptor;

const rbacDescriptor = (instance: object): IRbacDescriptor => Reflect.getMetadata(ACL_CONTROLLER_DESCRIPTOR, instance) as IRbacDescriptor;

const routesOf = (instance: object): IRoute[] => [...controllerDescriptor(instance).Routes.values()];

describe('Admin route contract', function () {
  this.timeout(25000);

  let controllers: Array<{ name: string; instance: object }>;

  before(async () => {
    DI.setESMModuleSupport();
    DI.register(TestConfiguration).as(Configuration);

    await DI.resolve(Configuration);

    controllers = [
      { name: 'Users', instance: await DI.resolve(Users) },
      { name: 'Roles', instance: await DI.resolve(Roles) },
      { name: 'Security', instance: await DI.resolve(Security) },
      { name: 'Profile', instance: await DI.resolve(Profile) },
    ];
  });

  after(() => {
    DI.clearCache();
  });

  describe('authorization', () => {
    /**
     * `@Permission` is what attaches RbacPolicy to a route — the controller-level
     * `@Policy(AuthorizedPolicy)` only proves somebody is logged in. A route
     * without it is readable ( or writable ) by every authenticated account in
     * the system, whatever their role.
     */
    it('every admin route declares a permission', () => {
      const unguarded: string[] = [];

      for (const { name, instance } of controllers) {
        const acl = rbacDescriptor(instance);

        for (const route of routesOf(instance)) {
          if (!acl.Routes.has(String(route.Method))) {
            unguarded.push(`${name}.${String(route.Method)}`);
          }
        }
      }

      expect(unguarded, 'routes without @Permission are open to every logged-in user').to.deep.eq([]);
    });

    it('every admin route is bound to the users resource', () => {
      for (const { name, instance } of controllers) {
        expect(rbacDescriptor(instance).Resource, `${name} is not bound to a resource`).to.eq('users');
      }
    });

    it('write routes require an :any permission', () => {
      const wrong: string[] = [];

      for (const { name, instance } of controllers) {
        const acl = rbacDescriptor(instance);

        for (const route of routesOf(instance)) {
          if (route.Type === RouteType.GET) {
            continue;
          }

          const permissions = acl.Routes.get(String(route.Method))?.Permission ?? [];

          if (!permissions.every((p) => p.endsWith('Any'))) {
            wrong.push(`${name}.${String(route.Method)} -> ${permissions.join(',')}`);
          }
        }
      }

      expect(wrong, 'an :own permission on an admin write route would let a user edit themselves through the admin API').to.deep.eq([]);
    });
  });

  describe('http verbs', () => {
    /** Reading is the only thing GET is allowed to do here. */
    const READ_ONLY_ROUTES = ['list', 'assignableRoles', 'getSingleUser', 'getByLogin', 'listSessions', 'getUserProfile'];

    it('no state-changing route answers GET', () => {
      const offenders: string[] = [];

      for (const { name, instance } of controllers) {
        for (const route of routesOf(instance)) {
          if (route.Type === RouteType.GET && !READ_ONLY_ROUTES.includes(String(route.Method))) {
            offenders.push(`${name}.${String(route.Method)}`);
          }
        }
      }

      expect(offenders, 'activating, deactivating or logging a user out over GET is triggerable by a link or a prefetch').to.deep.eq([]);
    });
  });

  describe('body schemas', () => {
    let validator: DataValidator;

    before(async () => {
      validator = await DI.resolve(DataValidator);
    });

    it('accepts a partial update', () => {
      expect(() => validator.validate(new UpdateUserDto({ Login: 'renamed' }))).to.not.throw();
      expect(() => validator.validate(new UpdateUserDto({ Email: 'renamed@spinajs.pl' }))).to.not.throw();
      expect(() => validator.validate(new UpdateUserDto({}))).to.not.throw();
    });

    it('rejects an update carrying fields this endpoint does not manage', () => {
      // Metadata used to be merged here from arbitrary request keys, which is
      // how a caller could write `user:pwd_reset:token` or a `*` glob.
      expect(() => validator.validate(new UpdateUserDto({ Metadata: { 'user:pwd_reset:token': 'x' } } as any))).to.throw();
    });

    it('still requires the full set of fields on creation', () => {
      expect(() => validator.validate(new CreateUserDto({ Login: 'newbie' } as any))).to.throw();
      expect(() => validator.validate(new CreateUserDto({ Login: 'newbie', Email: 'newbie@spinajs.pl', Role: 'user' }))).to.not.throw();
    });

    it('rejects a malformed email on creation', () => {
      expect(() => validator.validate(new CreateUserDto({ Login: 'newbie', Email: 'not-an-email', Role: 'user' }))).to.throw();
    });
  });
});
