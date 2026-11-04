import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import type { IDriverOptions } from '@spinajs/orm';
import { migrateTestDatabase } from '@spinajs/orm/testing';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, normalize, resolve } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { DateTime } from 'luxon';
import type { IdentityRef } from '@spinajs/authn/contracts';

import { NO_PASSWORD, USER_COMMON_METADATA, User } from '../../src/index.js';
import { TestConfiguration } from '../common.test.js';
import { registerAuthzHost } from './authz-host.js';

/** The registrations the Orm-backed users suites make in `before()`. */
export function registerUsersTestHost(): void {
  DI.register(TestConfiguration).as(Configuration);
  DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  registerAuthzHost();
}

// What `bootUsersDb` and the authz host leave in the root cache, uncached by name instead of `DI.clearCache()`: a suite
// drops what it owns, and a singleton an earlier suite left behind cannot hide this suite's fresh database.
const USERS_HOST_KEYS = [
  'Bootstrapper',
  'InternalLogger',
  'FsBootsrapper',
  'LogBotstrapper',
  'AuthzConfigBootstrapper',
  'RbacConfigBootstrapper',
  'RbacBootstrapper',
  '__configurationSchema__',
  'RbacUserModel',
  'ConfigurationSource',
  'JsFileSource',
  'JsonFileSource',
  'Configuration',
  'TestConfiguration',
  'BlackHoleTarget',
  'ConfigVariable',
  'MigrationSource',
  'FilesystemMigrationSource',
  'DiRegistryMigrationSource',
  '__orm_db_value_converters__',
  'QueryMiddleware',
  'ScopeUserModelToNothing',
  'PerfSink',
  'LogMetricSink',
  'SchemaSource',
  'FileSystemSource',
  'DataValidator',
  'ModelHydrator',
  'DbPropertyHydrator',
  'NonDbPropertyHydrator',
  'OneToManyRelationHydrator',
  'OneToOneRelationHydrator',
  'JunctionModelPropertyHydrator',
  'Orm',
  'OrmMigrator',
  'OrmMigrationGuard',
  'DefaultAuthzDomains',
  'LogDecisionAudit',
  'InProcessChangeBus',
  'ConfigRoleStore',
  'DbAssignmentStore',
  'UsersTestRbac',
  'OrmResourceAdapter',
  'AncestorMiddleware',
  'AccessGuardMiddleware',
  'AccessListMiddleware',
  'AuthzOrmContributor',
  'UserResourceAdapter',
  'UserSelfRelation',
  'UsersSelfRelation',
  'UserMetadataOwnerRelation',
  'ConfigScopeAttributeSchemas',
  'DefaultRolesBootCheck',
  'OwnRolesTokenRolePolicy',
  'TimeBetween',
  'IpIn',
  'GlobMatch',
  'WildcardMatch',
  'DefaultAuthzAdmin',
  'SystemClock',
  'DefaultAuthzService',
  'TestPasswordService',
  'DefaultAdminGuard',
  'DbAuthzAdminBackend',
  'ScopeAttributeHandler',
  'ScopeForgetHandler',
  'RbacAssignmentHandler',
  'RbacLinkHandler',
  'RbacRuleHandler',
  'LogAuthzEventSink',
  'DefaultQueueService',
  'DefaultEmailService',
  'DefaultHooks',
];

export function releaseUsersHost(): void {
  for (const key of USERS_HOST_KEYS) {
    DI.RootContainer.uncache(key);
  }
}

/**
 * Bootstraps, then migrates the test database and runs its seeds; the
 * suites call `releaseUsersHost()` after.
 * `configure` edits the resolved configuration before the Orm reads it.
 */
export async function bootUsersDb(configure?: (config: Configuration) => void): Promise<void> {
  releaseUsersHost();
  for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
    await b.bootstrap();
  }

  const config = await DI.resolve(Configuration, [null, null, [resolve(normalize(join(process.cwd(), 'test', './config')))]]);
  configure?.(config);
  await migrateTestDatabase();
}

const DATABASE_DIRS: string[] = [];

/**
 * Points the in-memory test connections at files of a fresh directory, so a migrate-up run and the boot after it are
 * separate Orms on one database, as in a deploy.
 */
export function useDatabaseFiles(config: Configuration): void {
  const dir = mkdtempSync(join(tmpdir(), 'spinajs-users-'));
  DATABASE_DIRS.push(dir);

  for (const connection of config.get<IDriverOptions[]>('db.Connections', [])) {
    if (connection.Filename === ':memory:') {
      connection.Filename = join(dir, `${connection.Name}.sqlite`);
    }
  }
}

/** Best effort: a connection a failed test left open keeps its file on windows. */
export function removeDatabaseFiles(): void {
  for (const dir of DATABASE_DIRS.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // nothing depends on it
    }
  }
}

/** What `npx spinajs migrate-up` does before a cli process starts: migrates and seeds in a container of its own. */
export async function migrateUpFirst(): Promise<void> {
  const { orm } = await migrateTestDatabase(DI.child());
  await orm.dispose();
}

export interface SeedSpec {
  readonly login: string;
  readonly email?: string;
  /** The stored value as is (a hash or a marker); default `NO_PASSWORD`. */
  readonly password?: string;
  readonly active?: boolean;
  readonly invitePending?: boolean;
}

/** Inserts a user row directly, without `create()`. */
export async function seedUser(spec: SeedSpec): Promise<{ user: User; ref: IdentityRef }> {
  const user = new User({
    Email: spec.email ?? `${spec.login}@seed.test`,
    Login: spec.login,
    Password: spec.password ?? NO_PASSWORD,
    IsActive: spec.active ?? true,
    Uuid: uuidv4(),
  });
  await user.insert();

  if (spec.invitePending) {
    user.Metadata[USER_COMMON_METADATA.USER_INVITE_PENDING] = true;
    await user.Metadata.update();
  }

  return { user, ref: { type: 'user', id: user.Uuid } };
}

/** The stored row, deleted ones included, with its metadata. */
export function storedUser(uuid: string): Promise<User> {
  return User.query().withDeleted().where('Uuid', uuid).populate('Metadata').firstOrFail() as Promise<User>;
}

export type IdentityFlags = { active?: boolean; banned?: boolean; deleted?: boolean; invitePending?: boolean };

/** Status flags only, written straight to the row and its metadata: no revocation, no event. */
export async function setIdentityFlags(ref: IdentityRef, flags: IdentityFlags): Promise<void> {
  const driver = User.query().Driver;
  const u = await storedUser(ref.id);

  if (flags.active !== undefined) {
    await driver.update().in('users').update({ IsActive: flags.active }).where('Uuid', ref.id);
  }
  if (flags.deleted !== undefined) {
    await driver
      .update()
      .in('users')
      .update({ DeletedAt: flags.deleted ? DateTime.utc() : null })
      .where('Uuid', ref.id);
  }
  for (const [flag, key] of [
    ['banned', USER_COMMON_METADATA.USER_BAN_IS_BANNED],
    ['invitePending', USER_COMMON_METADATA.USER_INVITE_PENDING],
  ] as const) {
    if (flags[flag] === true) {
      u.Metadata[key] = true;
      await u.Metadata.update();
    } else if (flags[flag] === false) {
      await u.Metadata.delete(key);
    }
  }
}
