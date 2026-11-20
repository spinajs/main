import { IMigrationLockRequest, IMigrationLockSession, OrmException, QueryContext, SessionMigrationLock } from '@spinajs/orm';
import { createHash } from 'node:crypto';
import type { MsSqlOrmDriver } from './index.js';

/** sp_getapplock takes an nvarchar(255) resource; a longer key is replaced by its digest. */
export function msSqlLockResource(key: string): string {
  return key.length <= 255 ? key : `spinajs_migration:${createHash('sha256').update(key).digest('hex')}`;
}

/**
 * A session-owned `sp_getapplock`, polled, on a pool of exactly one connection. Should the pool
 * replace that connection, the session ends and frees the lock, and `assertHeld()` sees it gone.
 */
export class MsSqlMigrationLock extends SessionMigrationLock {
  protected declare driver: MsSqlOrmDriver;

  protected async openSession(request: IMigrationLockRequest): Promise<IMigrationLockSession> {
    const resource = msSqlLockResource(request.key);
    // SQL Server has no idle session limit to turn off
    const pool = await this.driver.openDedicatedPool(this.sessionLabel());
    const scalar = async (sql: string) => ((await pool.request().input('res', resource).query(sql)).recordset?.[0] as { v?: unknown } | undefined)?.v;

    return {
      name: `sp_getapplock '${resource}'`,
      tryLock: async () => {
        const code = Number(await scalar(`DECLARE @r int; EXEC @r = sp_getapplock @Resource = @res, @LockMode = 'Exclusive', @LockOwner = 'Session', @LockTimeout = 0; SELECT @r AS v`));

        // -1 is the timeout, so another session holds it; anything lower means the call itself failed
        if (!(code >= -1)) {
          throw new OrmException(`sp_getapplock '${resource}' failed on connection ${this.driver.Options.Name} ( returned ${code} )`);
        }

        return code >= 0;
      },
      isLocked: async () => (await scalar(`SELECT APPLOCK_MODE('public', @res, 'Session') AS v`)) === 'Exclusive',
      unlock: async () => {
        await scalar(`EXEC sp_releaseapplock @Resource = @res, @LockOwner = 'Session'`);
      },
      close: () => pool.close(),
    };
  }

  protected async isLockedByAnySession(request: IMigrationLockRequest): Promise<boolean> {
    const rows = (await this.driver.executeOnDb(`SELECT APPLOCK_TEST('public', ?, 'Exclusive', 'Session') AS free`, [msSqlLockResource(request.key)], QueryContext.Select)) as Array<{ free: number }>;
    return rows[0]?.free === 0;
  }
}
