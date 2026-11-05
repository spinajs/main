import { IMigrationLockRequest, IMigrationLockSession, OrmException, QueryContext, SessionMigrationLock } from '@spinajs/orm';
import { createHash } from 'node:crypto';
import type { MySqlOrmDriver } from './index.js';

/** GET_LOCK names are server-wide and at most 64 characters long, hence a digest of the key, which names the database. */
export function mySqlLockName(key: string): string {
  return `spinajs_mig_${createHash('sha1').update(key).digest('hex')}`;
}

/** `GET_LOCK(name, 0)`, polled, on a connection of its own outside the pool. */
export class MySqlMigrationLock extends SessionMigrationLock {
  protected declare driver: MySqlOrmDriver;

  protected async openSession(request: IMigrationLockRequest): Promise<IMigrationLockSession> {
    const name = mySqlLockName(request.key);
    const connection = await this.driver.openDedicatedConnection(this.sessionLabel());

    try {
      // wait_timeout would end the session while a long migration runs on the pool. The largest value every platform
      // accepts: Windows caps it at 2147483 s, and a strict sql_mode rejects a larger one instead of clamping it
      await connection.query('SET SESSION wait_timeout = 2147483');
    } catch (err) {
      connection.destroy();
      throw err;
    }

    const scalar = async (sql: string) => {
      const [rows] = await connection.query(sql, [name]);
      return (rows as Array<{ v: unknown }>)[0].v;
    };

    return {
      name: `GET_LOCK('${name}')`,
      tryLock: async () => {
        const got = await scalar('SELECT GET_LOCK(?, 0) AS v');

        // NULL is not "taken by another session" but an error: out of memory, or the thread was killed
        if (got === null) {
          throw new OrmException(`GET_LOCK('${name}') failed on connection ${this.driver.Options.Name} ( returned NULL )`);
        }

        return Number(got) === 1;
      },
      isLocked: async () => Number(await scalar('SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS v')) === 1,
      unlock: async () => {
        await scalar('SELECT RELEASE_LOCK(?) AS v');
      },
      close: () => connection.end().catch(() => connection.destroy()),
    };
  }

  protected async isLockedByAnySession(request: IMigrationLockRequest): Promise<boolean> {
    const rows = (await this.driver.executeOnDb('SELECT IS_USED_LOCK(?) AS id', [mySqlLockName(request.key)], QueryContext.Select)) as Array<{ id: number | null }>;
    return rows[0]?.id != null;
  }
}
