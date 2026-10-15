import { _check_arg, _default, _non_empty, _trim } from '@spinajs/util';
import { Mutex, MutexLockOptions, LockResult, MutexLock, processIdentity } from '@spinajs/threading';
import { Config } from '@spinajs/configuration';
import { __mutex__ } from './models/__mutex__.js';
import { DateTime } from 'luxon';
import { IUpdateResult } from '@spinajs/orm';

export * from './migrations/Mutex_2024_12_03_11_41_00.js';
export * from './migrations/Mutex_2026_10_15_00_00_00.js';
export * from './migrations/Mutex_2026_10_15_00_00_01.js';
export * from './models/__mutex__.js';
export * from './db-clock.js';

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

  public async acquire(options: MutexLockOptions): Promise<LockResult> {
    const _tenant = this.tenantOf(options);
    const _name = this.nameOf(options.Name);

    let mutex = await this.get(options.Name);
    if (!mutex) {
      mutex = await this.create(options);
    }

    if (mutex.Locked && mutex.Tenant !== _tenant) {
      return {
        Locked: false,
        Mutex: null as any,
      };
    }

    const result = await (__mutex__ as any)
      .update({
        Locked: true,
        Tenant: _tenant,
      })
      .where({
        Name: _name,
      });

    return {
      Locked: result.RowsAffected === 1,
      Mutex: {
        ...mutex,
        Tenant: _tenant,
      },
    };
  }

  public async release(options: MutexLockOptions, deleteOnClose?: boolean): Promise<boolean> {
    const _name = this.nameOf(options.Name);
    const _tenant = this.tenantOf(options);
    let result: IUpdateResult = null as any;

    if (deleteOnClose) {
      result = await (__mutex__ as any).destroy(_name).where({
        Tenant: _tenant,
      });
    } else {
      result = await (__mutex__ as any)
        .update({
          Locked: false,
        })
        .where({
          Name: _name,
          Tenant: _tenant,
        });
    }

    return result.RowsAffected === 1;
  }

  public async create(options: MutexLockOptions): Promise<MutexLock> {
    const _name = this.nameOf(options.Name);
    const _tenant = this.tenantOf(options);

    const mutex = await (__mutex__ as any).getOrCreate(_name, {
      Name: _name,
      Tenant: _tenant,
    });

    return {
      ...mutex.dehydrate(),
    };
  }

  public async delete(options: MutexLockOptions): Promise<boolean> {
    const _name = this.nameOf(options.Name);
    const _tenant = this.tenantOf(options);

    /**
     * Delete mutex can only tenant
     * */
    const result = await (__mutex__ as any).destroy(_name).where({
      Tenant: _tenant,
    });
    return result.RowsAffected === 1;
  }

  public async get(name: string): Promise<MutexLock | null> {
    const _name = this.nameOf(name);
    return (__mutex__ as any).get(_name);
  }

  public async wait(name: string, timeout?: number): Promise<boolean> {
    const start = DateTime.now();

    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(async () => {
        try {
          const mutex = await this.get(name);
          if (!mutex!.Locked) {
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

  protected nameOf(name: string): string {
    return _check_arg(_trim(), _non_empty())(name, 'Empty mutex name');
  }

  protected tenantOf(options: MutexLockOptions): string {
    return _check_arg(_trim(), _default(() => this.ConfiguredTenant || processIdentity()))(options.Tenant, '');
  }
}
