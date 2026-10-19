import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log-common';
import { sleep as _utilSleep } from '@spinajs/util';

export * from "./mutex.js";

/**
 *
 * Sleep for a given duration in ms
 *
 * @param duration sleep duration in ms
 * @returns
 */
export const sleep = (duration: number) => _utilSleep(duration);

// Tail of the queue per section name; entries never reject.
const sections = new Map<string, Promise<void>>();

/**
 *
 * Creates code critical section - it allows to only one instance
 * of callback executed at once in nodejs current thread. Callers with the same
 * name run one after another, in call order.
 *
 * Basic implementation using promises
 *
 * @param name name of critical section
 * @param callback function to execute
 * @returns callback result; rejects with callback error
 */
export const criticalSection = <T>(name: string, callback: () => Promise<T>): Promise<T> => {
  const previous = sections.get(name) ?? Promise.resolve();

  const run = previous.then(async () => {
    // logger is optional, @spinajs/log may not be loaded
    const log = DI.resolve('__log__', ['THREADING']) as Log | null;

    try {
      log?.trace({ section: name }, 'Entering critical section ${section}');
      return await callback();
    } finally {
      log?.trace({ section: name }, 'Leaving critical section ${section}');
    }
  });

  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  sections.set(name, tail);
  void tail.then(() => {
    if (sections.get(name) === tail) {
      sections.delete(name);
    }
  });

  return run;
};

/**
 *
 * Rate limit function execution with custom delay
 * Basic implementation using promises
 *
 * @param name name of rate limit, internally it uses critical section to synchronize calls
 * @param callback function to limit executions
 * @param ms delay between calls in miliseconds
 * @returns callback result
 */
export const rateLimit = <T>(name: string, callback: () => T, ms: number) => {
  return criticalSection(name, () => delay(ms, callback));
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
