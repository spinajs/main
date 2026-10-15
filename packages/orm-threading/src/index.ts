import { _check_arg, _default, _non_empty, _trim } from '@spinajs/util';
import { Mutex, MutexLockOptions, LockResult, MutexLock, processIdentity } from '@spinajs/threading';
import { Config } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { IUpdateResult, Orm } from '@spinajs/orm';
import { DateTime } from 'luxon';
import { __mutex__ } from './models/__mutex__.js';
import { dbNowMs } from './db-clock.js';

export * from './migrations/Mutex_2024_12_03_11_41_00.js';
export * from './migrations/Mutex_2026_10_15_00_00_00.js';
export * from './migrations/Mutex_2026_10_15_00_00_01.js';
export * from './models/__mutex__.js';
export * from './db-clock.js';

/**
 * Database-backed mutex.
 *
 * The same tenant may acquire again; this is not counted, and one release frees the lock.
 * The default tenant is one per process, so replicas exclude each other, but concurrent
 * callers inside one process do not unless they pass distinct tenants.
 */
export class OrmMutex extends Mutex {
  /**
   * Fixed default tenant. Empty = identity of the current process. Setting one value on
   * every replica brings back the old shared tenant, where replicas do not exclude each other.
   */
  @Config('threading.mutex.tenant', {
    defaultValue: '',
  })
  protected ConfiguredTenant: string;

  /**
   * When waiting, interval time for check in db in ms
   */
  @Config('threading.mutex.checkInterval', {
    defaultValue: 500,
  })
  protected MutexWaitInterval: number;

  /**
   * Lock lifetime in ms when `ttl` is not passed. 0 = never expires.
   */
  @Config('threading.mutex.ttl', {
    defaultValue: 0,
  })
  protected DefaultTtl: number;

  public async acquire(options: MutexLockOptions): Promise<LockResult> {
    const name = this.nameOf(options.Name);
    const tenant = this.tenantOf(options);
    const ttl = this.ttlOf(options);

    let granted = await this.tryLock(name, tenant, ttl);
    if (!granted && !(await this.get(name))) {
      await this.createIfMissing(name, tenant);
      granted = await this.tryLock(name, tenant, ttl);
    }

    return {
      Locked: granted,
      Mutex: (await this.get(name))!,
    };
  }

  public async renew(options: MutexLockOptions): Promise<boolean> {
    const name = this.nameOf(options.Name);
    const tenant = this.tenantOf(options);
    const ttl = this.ttlOf(options);
    const now = await this.now();

    const result: IUpdateResult = await (__mutex__ as any)
      .update({
        LockedUntil: ttl > 0 ? now + ttl : null,
      })
      .where({
        Name: name,
        Tenant: tenant,
        Locked: true,
      });

    return result.RowsAffected === 1;
  }

  public async release(options: MutexLockOptions, deleteOnClose?: boolean): Promise<boolean> {
    const name = this.nameOf(options.Name);
    const tenant = this.tenantOf(options);
    let result: IUpdateResult = null as any;

    if (deleteOnClose) {
      result = await (__mutex__ as any).destroy(name).where({
        Tenant: tenant,
      });
    } else {
      result = await (__mutex__ as any)
        .update({
          Locked: false,
          LockedUntil: null,
        })
        .where({
          Name: name,
          Tenant: tenant,
        });
    }

    return result.RowsAffected === 1;
  }

  public async create(options: MutexLockOptions): Promise<MutexLock> {
    const name = this.nameOf(options.Name);
    const tenant = this.tenantOf(options);

    const mutex = await (__mutex__ as any).getOrCreate(name, {
      Name: name,
      Tenant: tenant,
    });

    return {
      ...mutex.dehydrate(),
    };
  }

  public async delete(options: MutexLockOptions): Promise<boolean> {
    const name = this.nameOf(options.Name);
    const tenant = this.tenantOf(options);

    const result = await (__mutex__ as any).destroy(name).where({
      Tenant: tenant,
    });
    return result.RowsAffected === 1;
  }

  public async get(name: string): Promise<MutexLock | null> {
    const row = await (__mutex__ as any).get(this.nameOf(name));

    // pg returns BIGINT as a string
    if (row && row.LockedUntil !== null && row.LockedUntil !== undefined) {
      row.LockedUntil = Number(row.LockedUntil);
    }

    return row;
  }

  public async wait(name: string, timeout?: number): Promise<boolean> {
    const start = DateTime.now();

    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(async () => {
        try {
          if (await this.isFree(name)) {
            clearInterval(checkInterval);
            resolve(true);
          } else {
            if (timeout !== 0) {
              if (DateTime.now().diff(start).milliseconds >= timeout!) {
                clearInterval(checkInterval);
                resolve(false);
              }
            }
          }
        } catch (err) {
          reject(err);
        }
      }, this.MutexWaitInterval);
    });
  }

  /**
   * One conditional UPDATE: atomic per row on every driver, so whoever changes the row owns the lock.
   * NULL LockedUntil never compares as expired.
   */
  protected async tryLock(name: string, tenant: string, ttl: number): Promise<boolean> {
    const now = await this.now();

    const result: IUpdateResult = await (__mutex__ as any)
      .update({
        Locked: true,
        Tenant: tenant,
        LockedUntil: ttl > 0 ? now + ttl : null,
      })
      .where('Name', name)
      .where(function (this: any) {
        this.where('Locked', false).orWhere('Tenant', tenant).orWhere('LockedUntil', '<', now);
      });

    return result.RowsAffected === 1;
  }

  protected async createIfMissing(name: string, tenant: string): Promise<void> {
    try {
      await this.create({ Name: name, Tenant: tenant });
    } catch (err) {
      // a concurrent acquire inserted the row first
      if (!(await this.get(name))) {
        throw err;
      }
    }
  }

  protected async isFree(name: string): Promise<boolean> {
    const mutex = await this.get(name);
    if (!mutex || !mutex.Locked) {
      return true;
    }

    return mutex.LockedUntil !== null && mutex.LockedUntil !== undefined && mutex.LockedUntil < (await this.now());
  }

  /**
   * Database clock, so replicas with skewed clocks agree on expiry.
   */
  protected now(): Promise<number> {
    const connection = (__mutex__ as any).getModelDescriptor().Connection;
    return dbNowMs(DI.get(Orm)!.Connections.get(connection)!);
  }

  protected nameOf(name: string): string {
    return _check_arg(_trim(), _non_empty())(name, 'Empty mutex name');
  }

  protected tenantOf(options: MutexLockOptions): string {
    return _check_arg(_trim(), _default(() => this.ConfiguredTenant || processIdentity()))(options.Tenant, '');
  }

  protected ttlOf(options: MutexLockOptions): number {
    const ttl = options.ttl ?? this.DefaultTtl;

    if (!Number.isFinite(ttl) || ttl < 0) {
      throw new InvalidArgument(`mutex ttl must be a non-negative number of ms, got ${ttl}`);
    }

    return ttl;
  }
}
