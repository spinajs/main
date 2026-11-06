import { PGlite } from '@electric-sql/pglite';

import { PglitePool, pgCompatibleParsers } from './pool-adapter.js';

/** How long an instance nobody holds stays open: long enough for the next test file of a run to take it over. */
export const SHARED_IDLE_CLOSE_MS = 1000;

interface SharedInstance {
  readonly pool: Promise<PglitePool>;
  users: number;
  idle?: NodeJS.Timeout;
}

const instances = new Map<string, SharedInstance>();

async function open(acquireTimeout: number): Promise<PglitePool> {
  const db = await PGlite.create();
  try {
    await db.exec(`SET TimeZone TO 'UTC'`);
    return new PglitePool(db, await pgCompatibleParsers(db), acquireTimeout);
  } catch (err) {
    await db.close();
    throw err;
  }
}

/**
 * The process-wide PGlite instance `name`, created on first use. Release every acquire once. An instance nobody holds
 * closes after `SHARED_IDLE_CLOSE_MS`; an open one keeps the process alive.
 */
export async function acquireSharedPglite(name: string, acquireTimeout: number): Promise<{ pool: PglitePool; release: () => void }> {
  let instance = instances.get(name);
  if (!instance) {
    const created: SharedInstance = { pool: open(acquireTimeout), users: 0 };
    created.pool.catch(() => instances.delete(name));
    instances.set(name, created);
    instance = created;
  }

  const held = instance;
  clearTimeout(held.idle);
  held.users++;
  const pool = await held.pool;

  let released = false;
  return {
    pool,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      held.users--;
      if (held.users === 0) {
        held.idle = setTimeout(() => {
          if (instances.get(name) === held) {
            instances.delete(name);
          }
          void pool.end();
        }, SHARED_IDLE_CLOSE_MS);
        held.idle.unref();
      }
    },
  };
}

/** Runs `sql` ( no values ) under a lease of the open instance `name`. False: the instance is not open, so there is nothing to run it on. */
export async function execOnSharedPglite(name: string, sql: string): Promise<boolean> {
  if (!instances.has(name)) {
    return false;
  }

  const { pool, release } = await acquireSharedPglite(name, 10000);
  try {
    const client = await pool.connect();
    try {
      await client.query(sql);
    } finally {
      client.release();
    }
  } finally {
    release();
  }

  return true;
}
