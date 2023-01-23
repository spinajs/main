import { TypedArray } from './array.js';
import { AsyncService, SyncService } from './interfaces.js';
import { Factory, Class } from './types.js';

/**
 * Checks if value is constructable type.
 * Checks for [[Construct]] internal function in object.
 *
 * @param value - value to test
 */
export function isConstructor(value: any): value is Class<unknown> {
  try {
    Reflect.construct(String, [], value);
  } catch (e) {
    return false;
  }

  return true;
}

export function isFactory(value: any): value is Factory<any> {
  return !isConstructor(value) && typeof value === 'function';
}

export function isObject(value: any): value is object {
  return typeof value === 'object';
}

export function isAsyncService(value: any): value is AsyncService {
  return value instanceof AsyncService;
}

export function isPromise(value: any): value is Promise<any> {
  return value instanceof Promise;
}

export function isSyncService(value: any): value is SyncService {
  return value instanceof SyncService;
}

/**
 * For DI purpose we  treat Map as array to inject. Difference is, that we fill map by some key
 * provided by mapFunc in \@Autoinject
 * @param value - value to check type
 * @returns
 */
export function isTypedArray(value: any): value is TypedArray<any> {
  return (value instanceof Array && value.constructor.name === 'TypedArray') || isMap(value);
}

export function isMap(value: any): value is Map<string, any> {
  return value instanceof Map && value.constructor.name === 'Map';
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

export function getTypeName(type: TypedArray<any> | Class<any> | string | object): string {
  return typeof type === 'string' ? type : isTypedArray(type) ? getTypeName(type.Type) : isConstructor(type) ? type.name : type.constructor.name;
}
