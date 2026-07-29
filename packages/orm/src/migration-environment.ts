import { normalizeEnvironment } from '@spinajs/configuration-common';
import { OrmException } from './exceptions.js';

/**
 * `ClassInfo.file` for a migration whose source file could not be determined - registered through
 * DI under a bundler that mangles stack paths. Such an entry has no suffix to read, so its
 * `@Migration({ Env })` option is its only env signal.
 */
export const MIGRATION_DI_SOURCE = '<di>';

/**
 * The environment tag carried by a migration's FILE NAME, normalized, or `undefined` when it has
 * none. The tag is the single dot-segment between the class name and the extension:
 *
 *   Foo_2026_07_29_10_00_00.ts        -> undefined  ( every environment )
 *   Foo_2026_07_29_10_00_00.local.ts  -> 'local'
 *   Foo_2026_07_29_10_00_00.dev.ts    -> 'dev'
 *
 * Only the BASENAME is examined - a project living under `C:\my.app\v1.2\` would otherwise read
 * its directory names as environments.
 */
export function parseMigrationFileEnv(file: string): string | undefined {
  // basename() only knows the host's separator, and a path can arrive in either form ( glob hands
  // back forward slashes even on win32 ), so both are cut here
  const base = file.split(/[\\/]/).pop() ?? file;
  const segments = base.split('.');

  // [name] alone is the '<di>' sentinel or an extensionless path; [name, ext] is unsuffixed
  if (segments.length <= 2) {
    return undefined;
  }

  // .d.ts is a TypeScript declaration file (routine compilation artifact), not an environment-tagged migration
  if (segments.length === 3 && segments[1] === 'd' && segments[2] === 'ts') {
    return undefined;
  }

  // .test.ts / .spec.ts are test-runner naming conventions (mocha, jest, vitest), not environment
  // tags - a migration declared inline in a suite file is exactly what `DiRegistryMigrationSource`
  // is for, and its `SourceFile` is that suite's own path. Without this carve-out every such
  // fixture would be misread as belonging to an environment literally named 'test' or 'spec' and
  // vanish under any other APP_ENV, which is the same false positive `.d.ts` guards against above.
  if (segments.length === 3 && (segments[1] === 'test' || segments[1] === 'spec')) {
    return undefined;
  }

  if (segments.length > 3) {
    throw new OrmException(`Migration file ${file} carries more than one environment tag (${segments.slice(1, -1).join(', ')}) - a migration belongs to exactly one environment. Rename it to <Name>_yyyy_MM_dd_HH_mm_ss.<env>.ts`);
  }

  // Reject empty middle segment (malformed filename like Foo..ts)
  if (segments[1] === '') {
    throw new OrmException(`Migration file ${file} has an empty environment segment - a migration belongs to exactly one environment. Rename it to <Name>_yyyy_MM_dd_HH_mm_ss.<env>.ts`);
  }

  return normalizeEnvironment(segments[1]);
}

/**
 * The environment a single discovered migration belongs to, from its file name and its
 * `@Migration({ Env })` option.
 *
 * Both present and disagreeing throws rather than picking a winner: the two are the same
 * declaration written twice, so a contradiction is always a mistake, and silently choosing one
 * means the migration runs somewhere nobody intended. Comparison happens after normalization, so
 * `.dev.ts` plus `{ Env: 'development' }` agree.
 */
export function resolveMigrationEnv(name: string, file: string, decoratorEnv?: string): string | undefined {
  const fromFile = parseMigrationFileEnv(file);
  // An empty decoratorEnv string means "decorator not declared" (returns undefined), which differs from
  // normalizeEnvironment('') that maps empty to 'prod'. Both are "unset" semantics: here, an absent or empty
  // decorator means no environment was declared, while APP_ENV defaults to 'prod' via normalizeEnvironment.
  const fromDecorator = decoratorEnv ? normalizeEnvironment(decoratorEnv) : undefined;

  if (fromFile !== undefined && fromDecorator !== undefined && fromFile !== fromDecorator) {
    throw new OrmException(`Migration ${name} declares environment '${fromDecorator}' via @Migration but its file ${file} is suffixed '${fromFile}'. Remove one of them.`);
  }

  return fromFile ?? fromDecorator;
}

/**
 * The environment of two entries that turned out to be the same migration - the same class name
 * reached from two origins, which is the NORMAL case: `src/` and `lib/` hold the same class, and a
 * file discovered on disk is also registered through DI by the import that discovered it.
 *
 * An absent env is not a vote and never conflicts, because the DI entry for a discovered
 * `.local` file carries no suffix - letting it "win" by arriving first would drop the tag and run
 * the migration everywhere. Two DIFFERENT envs are a genuine contradiction and throw.
 */
export function mergeMigrationEnv(name: string, a: { env?: string; file: string }, b: { env?: string; file: string }): string | undefined {
  if (a.env !== undefined && b.env !== undefined && a.env !== b.env) {
    throw new OrmException(`Migration ${name} is declared for environment '${a.env}' by ${a.file} and for '${b.env}' by ${b.file}. The same migration cannot belong to two environments.`);
  }

  return a.env ?? b.env;
}
