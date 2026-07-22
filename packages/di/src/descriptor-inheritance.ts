import 'reflect-metadata';
import _ from 'lodash';

/**
 * Walk the prototype chain of `target`, most derived first.
 *
 * Works for constructors ( Child -> Parent ) and for prototypes
 * ( Child.prototype -> Parent.prototype ) alike, since both are linked by
 * Object.getPrototypeOf. Keyed by identity - never by class name, so two
 * classes sharing a name never collapse into one another.
 */
function getInheritanceChain(target: object): object[] {
  const chain: object[] = [];
  let current: object | null = target;

  while (current && current !== Object.prototype && current !== Function.prototype) {
    chain.push(current);
    current = Object.getPrototypeOf(current) as object | null;
  }

  return chain;
}

/**
 * Merge rule for collapsing a descriptor down an inheritance chain.
 *
 * Ported verbatim from @spinajs/orm. NOTE: `_.isEmpty` returns true for
 * booleans and numbers, so for scalar fields a child's default value wins over
 * a parent's meaningful one. That is existing behavior and is preserved here
 * deliberately - changing it is a separate change with its own tests.
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
 * base class first, WITHOUT storing the result.
 *
 * The reduce is seeded with `createDefault()` so every key is present with its
 * proper type. That matters: the merger branches on `_.isMap(a)` / `_.isArray(a)`,
 * which only holds if the accumulator already carries real Maps and arrays.
 */
export function collapseInheritedDescriptor<T extends object>(target: object, symbol: symbol, createDefault: () => T): T {
  const chain = getInheritanceChain(target).reverse();

  return chain.reduce<T>((prev, klass) => {
    const own = Reflect.getOwnMetadata(symbol, klass) as Partial<T> | undefined;
    return own ? (_.assignWith(prev, own, descriptorMerger) as T) : prev;
  }, createDefault());
}

/**
 * Return the descriptor OWNED by `target`, creating it on first access by
 * collapsing the inheritance chain.
 *
 * Own metadata is the whole point: Reflect.getMetadata walks the prototype
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
