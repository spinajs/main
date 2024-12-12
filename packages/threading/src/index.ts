import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log-common';

export * from "./mutex.js";

/**
 *
 * Sleep for a given duration in ms
 *
 * @param duration sleep duration in ms
 * @returns
 */
export const sleep = (duration: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, duration);
  });
};

/**
 *
 * Creates code critival section - it allows to only one instance
 * of callback executed at once in nodejs current thread
 *
 * Basic implementation using promises
 *
 * @param name name of critical section
 * @param callback function to execute
 */
export const criticalSection = async <T>(name: string, callback: () => Promise<T>) => {
  const log = DI.resolve('__log__', ['THREADING']) as Log;

  /**
   * Get critical section mutex
   */
  const mutexes = DI.get<Map<string, Promise<void>>>('__mutex__');
  let mutex = Promise.resolve();

  if (mutexes && mutexes.has(name)) {
    mutex = mutexes.get(name);
  }

  // wait until mutex is released
  await mutex;

  // Start the critical section
  mutex = (async () => {
    try {
      log.trace(`Entering critical section ${name}`);
      await callback();
    } catch (err) {
      // release mutex before rethrow error
      DI.register(Promise.resolve()).asMapValue('__mutex__', name);
      throw err;
    } finally {
      log.trace(`Leaving critical section ${name}`);
    }
  })();

  // add to registry
  DI.register(mutex).asMapValue('__mutex__', name);
};

/**
 *
 * Rate limit function execution with custom delay
 * Basic implementation using promises
 *
 * @param name name of rate limit, internally it uses critical section to synchronize calls
 * @param callback function to limit executions
 * @param ms delay between calls in miliseconds
 */
export const rateLimit = <T>(name: string, callback: () => T, ms: number) => {
  return criticalSection(name, async () => {
    await delay(ms, callback);
  });
};

/**
 * Delay execution of a function for a given duration
 */
export const delay = <T>(duration: number, callback: () => T) => {
  return new Promise<T>((resolve, reject) => {
    setTimeout(() => {
      try {
        const result = callback();

        if (result instanceof Promise) {
          result.then(resolve).catch(reject);
          return;
        }

        resolve(result);
      } catch (e) {
        reject(e);
      }
    }, duration);
  });
};
