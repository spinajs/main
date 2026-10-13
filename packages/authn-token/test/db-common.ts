import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn';
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
 * `src/config/authn-token.ts` ships `system.dirs` pointing at
 * `<workspace>/node_modules/@spinajs/authn-token/lib/<mjs|cjs>/...`, and in
 * this repo that path is a symlink back to the package itself - so the config
 * is discovered ( the `node_modules/@spinajs/<pkg>/lib/mjs/config` glob ) while
 * the package's own tests are running.
 */
const OWN_COMPILED_DIRS = [normalize(join('@spinajs', 'authn-token', 'lib')), normalize(join(process.cwd(), 'lib'))];

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
 * node_modules. Only THIS package's paths are dropped - what other
 * packages contribute is left untouched.
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

/** As the authn bootstrapper does in an app: the schema fills the authn defaults the code no longer carries. */
export function registerAuthnSchema(): void {
  DI.register(AUTHN_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
}
