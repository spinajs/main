import { TypedArray } from './array';
import { AsyncModule, SyncModule } from './interfaces';
import { Factory, Class } from './types';

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

export function isAsyncModule(value: any): value is AsyncModule {
  return value instanceof AsyncModule;
}

export function isSyncModule(value: any): value is SyncModule {
  return value instanceof SyncModule;
}

export function isTypedArray(value: any): value is TypedArray<any> {
  return value instanceof TypedArray;
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
  return typeof type === 'string' ? type : type instanceof TypedArray ? type.Type.name : isConstructor(type) ? type.name : type.constructor.name;
}
