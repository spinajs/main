import { advisoryKeyPair, IMigrationLockRequest, IMigrationLockSession, QueryContext, SessionMigrationLock } from '@spinajs/orm';
import type { PostgresOrmDriver } from './index.js';

// pg_locks shows the two int4 halves of the key as unsigned oids
const GRANTED = `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND classid = $1 AND objid = $2 AND objsubid = 2 AND granted`;

/**
 * `pg_try_advisory_lock(k1, k2)`, polled, on a client of its own outside the pool. Session-scoped:
 * behind PgBouncer in transaction pooling it is not held reliably, so use `Migration.Lock.Mode: 'table'` there.
 */
export class PostgresMigrationLock extends SessionMigrationLock {
  protected declare driver: PostgresOrmDriver;

  protected async openSession(request: IMigrationLockRequest): Promise<IMigrationLockSession> {
    const [k1, k2] = advisoryKeyPair(request.key);
    const client = await this.driver.openDedicatedClient(this.sessionLabel());

    try {
      // idle_session_timeout ( 14+ ) would end the session while a long migration runs on the pool
      const { rows } = await client.query<{ v: number }>(`SELECT current_setting('server_version_num')::int AS v`);
      if (rows[0].v >= 140000) {
        await client.query('SET idle_session_timeout = 0');
      }
    } catch (err) {
      await client.end().catch(() => undefined);
      throw err;
    }

    return {
      name: `pg advisory lock (${k1}, ${k2})`,
      tryLock: async () => (await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS ok', [k1, k2])).rows[0].ok,
      isLocked: async () => (await client.query(`${GRANTED} AND pid = pg_backend_pid()`, [k1 >>> 0, k2 >>> 0])).rowCount !== 0,
      unlock: async () => {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [k1, k2]);
      },
      close: () => client.end(),
    };
  }

  protected async isLockedByAnySession(request: IMigrationLockRequest): Promise<boolean> {
    const [k1, k2] = advisoryKeyPair(request.key);
    const rows = (await this.driver.executeOnDb(GRANTED, [k1 >>> 0, k2 >>> 0], QueryContext.Select)) as unknown[];
    return rows.length !== 0;
  }
}
