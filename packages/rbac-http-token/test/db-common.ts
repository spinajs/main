import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { MigrationTransactionMode } from '@spinajs/orm';
import { join, normalize, resolve } from 'path';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

chai.use(chaiAsPromised);

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

/**
 * Path fragments of THIS package's own compiled output.
 *
 * `src/config/rbac-http-token.ts` ships `system.dirs` pointing at
 * `<workspace>/node_modules/@spinajs/rbac-http-token/lib/<mjs|cjs>/...`, and in
 * this repo that path is a symlink back to the package itself - so the config
 * is discovered ( the `node_modules/@spinajs/<pkg>/lib/mjs/config` glob ) while
 * the package's own tests are running.
 */
const OWN_COMPILED_DIRS = [normalize(join('@spinajs', 'rbac-http-token', 'lib')), normalize(join(process.cwd(), 'lib'))];

/**
 * Removes this package's compiled dirs from `system.dirs`.
 *
 * Configuration MERGES arrays ( `mergeArrays` in `configuration/src/util-common.ts`
 * concatenates - that is how a package contributes its dirs to an app ), so the
 * shipped config's `lib/...` entries are ADDED to the `src/...` entries a test
 * declares rather than replaced by them. Both copies of every controller, model
 * and migration would then be loaded, and the compiled twin - registered after
 * the orm has already built its descriptors from the source one - wins the route
 * table while carrying no column information, which surfaces as 500s and
 * `INSERT INTO rbac_access_tokens (user_id)` with every other column dropped.
 *
 * A deployed application only ever has the compiled copy, so this is an artifact
 * of testing the sources of a package that is symlinked into its own
 * node_modules. Only THIS package's paths are dropped - what `@spinajs/rbac`
 * and friends contribute is left untouched.
 */
export function dropOwnCompiledDirs(cfg: Configuration): void {
  for (const kind of ['cli', 'controllers', 'migrations', 'models']) {
    const dirs = cfg.get<string[]>(['system', 'dirs', kind], []);

    // An ABSENT key must stay absent - writing `[]` back would be a different
    // thing than not configuring it at all, e.g. `FilesystemMigrationSource`
    // reads `system.dirs.migrations` as "configured" by its length and would
    // start distinguishing a key this helper materialized from one nobody set.
    if (!dirs.length) {
      continue;
    }

    cfg.set(
      ['system', 'dirs', kind],
      dirs.filter((d) => !OWN_COMPILED_DIRS.some((fragment) => normalize(d).includes(fragment))),
    );
  }
}

/**
 * Boots in-memory sqlite with rbac + this package's migrations and models.
 * No http server.
 */
export class DbTestConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    dropOwnCompiledDirs(this);
  }

  protected onLoad(): unknown {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      system: {
        dirs: {
          // A configured value REPLACES the orm defaults, so this list is the whole
          // filesystem scan set: this package's migrations, run from source. `@spinajs/rbac`'s
          // own migrations still arrive through the DI registry ( its index exports them and
          // the tests import it ), so the users table is created regardless.
          migrations: [dir('./../src/migrations')],
          // Not read by the orm ( models are registered by the `@Model` decorator when the
          // file is imported ) - kept for symmetry with how apps declare their dirs.
          models: [dir('./../src/models')],
        },
      },
      rbac: {
        defaultRole: 'guest',
        roles: [
          { Name: 'admin', Description: 'Administrator' },
          { Name: 'user', Description: 'Simple account' },
          { Name: 'guest', Description: 'Guest account' },
        ],
        grants: {
          admin: {
            users: { 'create:any': ['*'], 'read:any': ['*'], 'update:any': ['*'], 'delete:any': ['*'] },
            'user.tokens': { 'create:any': ['*'], 'read:any': ['*'], 'update:any': ['*'], 'delete:any': ['*'] },
          },
          user: {
            user: { 'read:own': ['*'], 'update:own': ['*'] },
            'user.tokens': { 'create:own': ['*'], 'read:own': ['*'], 'update:own': ['*'], 'delete:own': ['*'] },
          },
        },
        session: {
          service: 'MemorySessionStore',
          expiration: { service: 'SlidingCappedExpiration', ttl: 120, maxLifetime: 1440 },
          cookie: {},
        },
        auth: { service: 'SimpleDbAuthProvider' },
        password: {
          service: 'BasicPasswordProvider',
          validation: {
            service: 'BasicPasswordValidationProvider',
            rule: { pattern: '^(?=.*\\d).{8,}$', type: 'string' },
          },
          passwordExpirationTime: 0,
          passwordResetWaitTime: 60 * 60,
        },
        token: {
          generation: { service: 'SecureRandomTokenProvider' },
          prefix: 'spt_',
          length: 32,
          headerName: 'x-api-key',
          lastUsedUpdateInterval: 60,
        },
      },
      queue: {
        default: 'default-test-queue',
        connections: [{ service: 'BlackHoleQueueClient', name: 'default-test-queue' }],
      },
      db: {
        DefaultConnection: 'sqlite',
        Connections: [
          {
            Driver: 'orm-driver-sqlite',
            Filename: ':memory:',
            Name: 'sqlite',
            Migration: {
              Table: 'orm_migrations',
              OnStartup: true,
              Transaction: { Mode: MigrationTransactionMode.PerMigration },
            },
          },
        ],
      },
    };
  }
}
