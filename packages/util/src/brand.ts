// Brand checks that work across realms, through built-in methods that throw on a receiver without the internal slot.
// Throwing is slow, so a cheap Object.prototype.toString test goes first. Not exported from the package index.

const getTime = Date.prototype.getTime;
const toTag = Object.prototype.toString;

/** The time value of any Date, from any realm and also an invalid one ( `NaN` ); `undefined` for anything else. */
export function dateTimeOf(v: unknown): number | undefined {
  if (v === null || typeof v !== 'object') return undefined;
  if (!(v instanceof Date) && toTag.call(v) !== '[object Date]') return undefined;
  try {
    return getTime.call(v);
  } catch {
    return undefined;
  }
}

const probe =
  (fn: (this: unknown) => unknown) =>
  (v: object): boolean => {
    try {
      fn.call(v);
      return true;
    } catch {
      return false;
    }
  };

const getter = (proto: object, name: string): ((this: unknown) => unknown) => Object.getOwnPropertyDescriptor(proto, name)!.get!;

// Built-ins whose toString tag comes from their prototype, so a reset prototype hides them.
const SLOT_PROBES: ReadonlyArray<(v: object) => boolean> = [
  probe(getter(Map.prototype, 'size')),
  probe(getter(Set.prototype, 'size')),
  probe(function (this: unknown) {
    WeakMap.prototype.has.call(this, {});
  }),
  probe(function (this: unknown) {
    WeakSet.prototype.has.call(this, {});
  }),
  probe(getter(ArrayBuffer.prototype, 'byteLength')),
  probe(Symbol.prototype.valueOf),
  probe(BigInt.prototype.valueOf),
];

/**
 * True for objects whose content lives in internal slots ( Map, Set, Date, boxed primitives, buffers, RegExp ... ),
 * so their own keys say nothing about what they hold. A Map, Set, WeakMap, WeakSet, ArrayBuffer or boxed symbol or
 * bigint whose prototype was reset is caught only while it has no own keys; promises are not detected.
 */
export function hasInternalSlots(v: object): boolean {
  if (ArrayBuffer.isView(v) || toTag.call(v) !== '[object Object]') return true;
  return Reflect.ownKeys(v).length === 0 && SLOT_PROBES.some((is) => is(v));
}
