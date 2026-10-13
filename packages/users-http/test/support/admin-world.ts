import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import type { Principal } from '@spinajs/authz';
import type { AuthnFacts, IdentityRef } from '@spinajs/authn/contracts';
import { User, UserPrincipalFactory } from '@spinajs/users';

import { Users } from '../../src/admin/controllers/Users/Users.js';
import { Security } from '../../src/admin/controllers/Users/Security.js';
import { Profile } from '../../src/admin/controllers/Users/Profile.js';
import { TestConfiguration } from '../admin-common.js';
import { registerAuthzHost, seedRoles } from './authz-host.js';
import { testHasher } from './hasher.js';

export const ADMIN_UUID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
export const ADMIN2_UUID = 'dddddddd-4444-4444-8444-dddddddddddd';
export const USER_UUID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
export const INACTIVE_UUID = 'cccccccc-3333-4333-8333-cccccccccccc';

export interface AdminWorld {
  users: Users;
  security: Security;
  profile: Profile;
}

/** The registrations of the admin suites, for their `before()`. */
export function registerAdminWorld(): void {
  DI.setESMModuleSupport();

  DI.register(TestConfiguration).as(Configuration);
  DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  registerAuthzHost();
}

/**
 * Boots a fresh in-memory database and seeds four accounts. TWO administrators, because the account guard
 * refuses any operation that would leave none: a single-admin fixture would make every deactivate, delete or
 * revoke test fail for the wrong reason.
 */
export async function bootAdminWorld(): Promise<AdminWorld> {
  for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
    await b.bootstrap();
  }

  await DI.resolve(Configuration);
  await DI.resolve(Orm);

  await seedAccounts();

  return {
    users: await DI.resolve(Users),
    security: await DI.resolve(Security),
    profile: await DI.resolve(Profile),
  };
}

async function seedAccounts(): Promise<void> {
  const admin = new User({ Uuid: ADMIN_UUID, Email: 'admin@spinajs.pl', Login: 'admin', Password: await testHasher.hash('admin1234'), IsActive: true });
  await admin.insert();
  admin.Metadata['user:niceName'] = 'The Admin';
  await admin.Metadata.sync();

  await new User({ Uuid: ADMIN2_UUID, Email: 'admin2@spinajs.pl', Login: 'admin2', Password: await testHasher.hash('admin1234'), IsActive: true }).insert();

  const user = new User({ Uuid: USER_UUID, Email: 'user@spinajs.pl', Login: 'user', Password: await testHasher.hash('user1234'), IsActive: true });
  await user.insert();
  user.Metadata['user:niceName'] = 'Regular User';
  user.Metadata['user:phone'] = '123456789';
  await user.Metadata.sync();

  await new User({ Uuid: INACTIVE_UUID, Email: 'inactive@spinajs.pl', Login: 'inactive', Password: await testHasher.hash('inactive1234'), IsActive: false }).insert();

  await seedRoles(ADMIN_UUID, ['admin']);
  await seedRoles(ADMIN2_UUID, ['admin']);
  await seedRoles(USER_UUID, ['user']);
  await seedRoles(INACTIVE_UUID, ['user']);
}

export const byUuid = (uuid: string) => User.where({ Uuid: uuid }).populate('Metadata').firstOrFail() as Promise<User>;

/** The principal of user `uuid`, as the handlers get it from `@CurrentPrincipal()`. */
export async function principalOf(uuid: string): Promise<Principal> {
  return ((await DI.resolve(UserPrincipalFactory)) as UserPrincipalFactory).principalOf(await byUuid(uuid));
}

/** The principal of user `uuid` signed in with a password session: what the credential admin guard asks of an actor. */
export async function signedInPrincipalOf(uuid: string): Promise<Principal> {
  const facts: AuthnFacts = { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(), sessionHandle: `test-session-${uuid}` };
  return ((await DI.resolve(UserPrincipalFactory)) as UserPrincipalFactory).principalOf({ type: 'user', id: uuid } as IdentityRef, facts, {});
}
