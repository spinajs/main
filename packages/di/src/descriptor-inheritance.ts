import 'reflect-metadata';
import _ from 'lodash';

/**
 * Find the nearest object in the prototype chain of `target`, starting at
 * `target` itself, that owns metadata under `symbol`. Returns undefined when
 * nothing in the chain has been decorated.
 *
 * Works for constructors ( `Child` then `Parent` ) and for prototypes
 * ( `Child.prototype` then `Parent.prototype` ) alike, since both are linked
 * by `Object.getPrototypeOf`. Keyed by identity - never by class name, so two
 * classes sharing a name never collapse into one another.
 *
 * Classes that were never decorated own no metadata, so the walk simply passes
 * over them ( eg. an undecorated class sitting between two decorated ones ).
 */
function findNearestOwnDescriptor<T extends object>(target: object, symbol: symbol): Partial<T> | undefined {
  let current: object | null = target;

  while (current && current !== Object.prototype && current !== Function.prototype) {
    const own = Reflect.getOwnMetadata(symbol, current) as Partial<T> | undefined;

    if (own) {
      return own;
    }

    current = Object.getPrototypeOf(current) as object | null;
  }

  return undefined;
}

/**
 * Merge rule for collapsing a descriptor down an inheritance chain.
 *
 * Ported verbatim from `@spinajs/orm`. Two quirks come with it:
 *
 * NOTE: `_.isEmpty` returns true for booleans and numbers, so for scalar fields
 * a child's default value wins over a parent's meaningful one. That is existing
 * behavior and is preserved here deliberately - changing it is a separate
 * change with its own tests.
 *
 * NOTE: arrays and Maps are always rebuilt, but any other object falls through
 * to `return b` and is therefore shared by reference between parent and child.
 * Mutating a nested plain object in place on a child writes through to the
 * parent ( eg. `child.Nested.Field = x` is visible on the parent ). Prefer flat
 * descriptors - scalars, arrays and Maps - or replace nested objects wholesale
 * rather than mutating them.
 *
 * NOTE: "rebuilt" means ONE LEVEL DEEP. The new array / Map is a fresh
 * container, but its ELEMENTS are the parent's objects, shared by reference -
 * so a flat-looking descriptor whose Map holds objects has exactly the hazard
 * above one level down ( eg. `child.Routes.get('x').Path = y` rewrites the
 * parent's route ). A consumer that mutates elements in place must copy them
 * itself right after the collapse; one that only ever replaces whole elements
 * ( eg. `Map.set(key, freshObject)` ) needs no copy.
 */
const descriptorMerger = (a: unknown, b: unknown): unknown => {
  if (_.isArray(a) || _.isArray(b)) {
    return [...((a as unknown[]) ?? []), ...((b as unknown[]) ?? [])];
  }

  if (!(_.isNil(a) || _.isEmpty(a)) && (_.isNil(b) || _.isEmpty(b))) {
    return a;
  }

  if (_.isMap(a)) {
    return new Map([...(a as Map<unknown, unknown>), ...((b as Map<unknown, unknown>) ?? new Map())]);
  }

  return b;
};

/**
 * Compute the descriptor for `target` by collapsing its inheritance chain,
 * WITHOUT storing the result.
 *
 * Only the NEAREST descriptor in the chain is merged, not every ancestor's.
 * That is load-bearing and worth spelling out: every stored descriptor is
 * itself already collapsed - `getInheritedDescriptor` only ever writes a
 * fully collapsed value - so the nearest one already carries every ancestor's
 * contribution. Merging the whole chain would fold those contributions in a
 * second time, and since the merger concatenates arrays, array fields would
 * gain a duplicate per inheritance level ( eg. a three level chain yielding
 * `['a', 'a', 'b', 'c']` ).
 *
 * The merge is seeded with `createDefault()` so every key is present with its
 * proper type. That matters: the merger branches on `_.isMap(a)` / `_.isArray(a)`,
 * which only holds if the accumulator already carries real Maps and arrays.
 * Seeding also means the caller gets a fresh copy rather than the stored object.
 */
export function collapseInheritedDescriptor<T extends object>(target: object, symbol: symbol, createDefault: () => T): T {
  const nearest = findNearestOwnDescriptor<T>(target, symbol);
  const descriptor = createDefault();

  return nearest ? (_.assignWith(descriptor, nearest, descriptorMerger) as T) : descriptor;
}

/**
 * Return the descriptor OWNED by `target`, creating it on first access by
 * collapsing the inheritance chain.
 *
 * Own metadata is the whole point: `Reflect.getMetadata` walks the prototype
 * chain, so a subclass would otherwise find - and mutate - its parent's
 * descriptor. With own metadata each class has its own copy, pre-populated
 * with everything it inherited.
 */
export function getInheritedDescriptor<T extends object>(target: object, symbol: symbol, createDefault: () => T): T {
  const own = Reflect.getOwnMetadata(symbol, target) as T | undefined;

  if (own) {
    return own;
  }

  const descriptor = collapseInheritedDescriptor(target, symbol, createDefault);
  Reflect.defineMetadata(symbol, descriptor, target);

  return descriptor;
}
