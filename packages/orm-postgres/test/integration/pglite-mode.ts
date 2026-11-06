import type { Constructor } from '@spinajs/di';
import 'mocha';

import type { PostgresOrmDriver } from '../../src/index.js';

/** `ORM_TEST_POSTGRES_DRIVER=pglite` runs these suites in process on `@spinajs/orm-pglite` instead of a server. */
export const PGLITE = process.env.ORM_TEST_POSTGRES_DRIVER === 'pglite';

export const PGLITE_DRIVER = 'orm-driver-pglite';

// Loaded by name, not declared: orm-pglite depends on this package, and a dependency back would be a workspace cycle.
const PGLITE_PACKAGE = '@spinajs/orm-pglite';

export async function pgliteDriver(): Promise<Constructor<PostgresOrmDriver>> {
  const loaded = (await import(PGLITE_PACKAGE)) as { PgliteOrmDriver: Constructor<PostgresOrmDriver> };
  return loaded.PgliteOrmDriver;
}

export function secondSessionError(): Error {
  return new Error('PGlite has one session, so a second, independent session cannot be opened (ORM_TEST_POSTGRES_DRIVER=pglite)');
}

/**
 * What cannot run on PGlite, by mocha full title of a test or a suite. Each reason starts with its kind:
 * `second-session` (needs another session beside the ORM's), `server-admin` (creates databases or changes database
 * defaults), `server-restart` (restarts the server), `pglite-gap` (PostgreSQL behaviour PGlite does not have).
 */
export const PGLITE_SKIPS: Readonly<Record<string, string>> = {
  'postgres lockTableShared (integration)': 'second-session: checks the SHARE lock from another pg.Client session',
  'postgres OrmMigrator table info re-read (integration)': 'server-admin: creates and drops a database per test through an admin session',
  'postgres strict table check (integration)': 'server-admin: creates and drops a database per test through an admin session',
  'postgres integration - time (database default zone America/New_York)': 'server-admin: sets the database default time zone through an admin session',
  'postgres integration - infrastructure recovers the pool after the server restarts, without restarting the process': 'server-restart: restarts the docker container of the server',
  'postgres integration - transactions keeps a REPEATABLE READ snapshot against a concurrent commit': 'second-session: commits from another session inside the transaction',
  'postgres integration - transactions sees a concurrent commit under READ COMMITTED': 'second-session: commits from another session inside the transaction',
  'postgres integration - time (process zone Europe/Warsaw) reads an instant another client wrote in a non-UTC session, at millisecond precision': 'second-session: writes through another client session',
};

export function pgliteSkip(title: string | undefined): string | undefined {
  return PGLITE && title !== undefined ? PGLITE_SKIPS[title] : undefined;
}

if (PGLITE) {
  // A root hook: the harness imports this module before any suite of the run is defined.
  beforeEach(function () {
    if (pgliteSkip(this.currentTest?.fullTitle())) {
      this.skip();
    }
  });
}
