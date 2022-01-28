import { AsyncModule, SyncModule } from './interfaces';
import { Factory, Class } from './types';

/**
 * Checks if value is constructable type.
 * Checks for [[Construct]] internal function in object.
 *
 * @param value - value to test
 */
export function isConstructor(value: Class<unknown> | Factory<unknown>): value is Class<unknown> {
  try {
    Reflect.construct(String, [], value);
  } catch (e) {
    return false;
  }

  return true;
}

export function isFactory(value: Class<unknown> | Factory<unknown>): value is Factory<unknown> {
  return !isConstructor(value) && typeof value === 'function';
}

export function isAsyncModule(value: unknown): value is AsyncModule {
  return value instanceof AsyncModule;
}

export function isSyncModule(value: unknown): value is SyncModule {
  return value instanceof SyncModule;
}

export function uniqBy<T>(arr: T[], comparator: (a: T, b: T) => boolean) {
  const uniques = [];
  for (const a of arr) {
    if (uniques.findIndex((u) => comparator(a, u)) === -1) {
      uniques.push(a);
    }
  }
  return uniques;
}
