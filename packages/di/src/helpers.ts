import { TypedArray } from './array.js';
import { ResolveException } from './exceptions.js';
import { AsyncService, SyncService } from './interfaces.js';
import { Factory, Class } from './types.js';
// re-exported from @spinajs/util to keep a single implementation across the framework
export { isPromise } from '@spinajs/util';
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

/**
 *
 * Dirty way for check if type is class type
 * NOTE: it will not work with transpilers that
 * compile js class into functions
 *
 * @param obj
 * @returns
 */
export function isClass(obj: any) {
  const isCtorClass = obj.constructor && obj.constructor.toString().substring(0, 5) === 'class';
  if (obj.prototype === undefined) {
    return isCtorClass;
  }
  const isPrototypeCtorClass = obj.prototype.constructor && obj.prototype.constructor.toString && obj.prototype.constructor.toString().substring(0, 5) === 'class';
  return isCtorClass || isPrototypeCtorClass;
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

/**
 * Sorts items so that every item comes after the items it depends on
 * ( stable DFS topological sort - items with no dependencies keep input order ).
 *
 * Use it to order creation of services that reference each other by name,
 * eg. fs providers where temp fs wraps another configured provider.
 *
 * @param items - items to sort
 * @param key - returns unique identifier of an item
 * @param dependencies - returns identifier(s) of items given item depends on
 *                       ( string, string[], or undefined/null for none )
 *
 * Throws ResolveException on: duplicate keys, dependency on itself,
 * dependency that does not exist in items, circular dependency
 * ( message includes cycle path, eg. 'a' -\> 'b' -\> 'a' )
 */
export function sortByDependencies<T>(items: T[], key: (item: T) => string, dependencies: (item: T) => string | string[] | null | undefined): T[] {
  const byKey = new Map<string, T>();
  for (const item of items) {
    const k = key(item);
    if (byKey.has(k)) {
      throw new ResolveException(`Duplicate key '${k}' found while sorting by dependencies`);
    }
    byKey.set(k, item);
  }

  const ordered: T[] = [];
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (k: string, item: T) => {
    if (visited.has(k)) {
      return;
    }

    if (stack.includes(k)) {
      throw new ResolveException(`Circular dependency detected: ${[...stack, k].map((x) => `'${x}'`).join(' -> ')}`);
    }

    stack.push(k);

    const deps = dependencies(item);
    for (const dep of deps ? (Array.isArray(deps) ? deps : [deps]) : []) {
      if (dep === k) {
        throw new ResolveException(`'${k}' depends on itself`);
      }

      const depItem = byKey.get(dep);
      if (!depItem) {
        throw new ResolveException(`'${k}' depends on '${dep}' which does not exist in sorted collection`);
      }

      visit(dep, depItem);
    }

    stack.pop();
    visited.add(k);
    ordered.push(item);
  };

  for (const [k, item] of byKey) {
    visit(k, item);
  }

  return ordered;
}
