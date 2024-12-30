import { DI } from '@spinajs/di';
import { DateTime } from 'luxon';

/**
 * Mutex data
 */
export interface MutexLock {
  /**
   * Name of mutex
   */
  Name: string;

  /**
   * Who is currently locked
   */
  Tenant: string;

  /**
   * Mutex state
   */
  Locked: boolean;

  /**
   * Creation time
   */
  Created_at: DateTime;

  /**
   * Update time ( lock changed)
   */
  Updated_at: DateTime;
}

export interface MutexLockOptions {
  /**
   * Mutex name
   */
  Name: string;

  /**
   * Who is locking. If not set - name of current process is set
   */
  Tenant?: string;
}

/**
 * Mutext lock result
 */
export interface LockResult {
  /**
   * True if lock is granted
   * False otherwise
   */
  Locked: boolean;

  /**
   * Mutext data
   */
  Mutex: MutexLock;
}

export abstract class Mutex {
  /**
   * Acquire mutex. If not exists, creates it
   * @param options
   */
  public abstract acquire(options: MutexLockOptions): Promise<LockResult>;

  /**
   *
   * Release mutex lock
   *
   * @param name
   * @param deleteOnClose
   */
  public abstract release(options: MutexLockOptions, deleteOnClose?: boolean): Promise<boolean>;

  /**
   * Create mutex. It will not lock it
   * @param options
   */
  public abstract create(options: MutexLockOptions): Promise<MutexLock>;

  /**
   * Deletes mutex if its not locked
   * @param name
   * @returns true if deleted
   */
  public abstract delete(options: MutexLockOptions): Promise<boolean>;

  /**
   * Retrieve mutex information if exists
   * @param name
   */
  public abstract get(name: string): Promise<MutexLock | null>;

  /**
   *
   * Waits for mutex until released. I timeout is provided returns false after timeout
   * By default  waits until is released
   *
   * @param name
   * @param timeout in ms, if set to 0 will wait forever
   */
  public abstract wait(name: string, timeout?: number): Promise<boolean>;
}

/**
 * Create mutex. It will not lock it
 * @param options
 */
export function mutex_create(options: MutexLockOptions): Promise<MutexLock> {
  return DI.resolve(Mutex).create(options);
}

/**
 * Retrieve mutex information if exists
 * @param name
 */
export function mutex_get(name: string): Promise<MutexLock | null> {
  return DI.resolve(Mutex).get(name);
}

/**
 *
 * Waits for mutex until released. I timeout is provided returns false after timeout
 * By default  waits until is released
 *
 * @param name
 * @param timeout in ms, if set to 0 will wait forever
 */
export function mutex_wait(name: string, timeout?: number): Promise<boolean> {
  return DI.resolve(Mutex).wait(name, timeout);
}

/**
 * Deletes mutex if its not locked
 * @param name
 * @returns true if deleted
 */
export function mutex_delete(options: MutexLockOptions): Promise<boolean> {
  return DI.resolve(Mutex).delete(options);
}

/**
 * Acquire mutex. If not exists, creates it
 * @param options
 */
export function mutex_acquire(options: MutexLockOptions): Promise<LockResult> {
  return DI.resolve(Mutex).acquire(options);
}

/**
 *
 * Release mutex lock
 *
 * @param name
 * @param deleteOnClose
 */
export function mutex_release(options : MutexLockOptions, deleteOnClose?: boolean): Promise<boolean> {
  return DI.resolve(Mutex).release(options, deleteOnClose);
}
