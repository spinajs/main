type ArrayItemType<T> = T extends (infer U)[] ? U : T;

/**
 * Makes array from single value. If passed value is already array
 * return value
 *
 * @param val val to convert
 * @returns val if array, or [val]
 */
export const toArray = <T>(val: ArrayItemType<T> | ArrayItemType<T>[]): ArrayItemType<T>[] => {
  return global.Array.isArray(val) ? val : val ? [val] : [];
};

/**
 * Splits an array into consecutive chunks of at most `size` elements.
 *
 * @param arr - source array ( not mutated )
 * @param size - max chunk length ( must be >= 1 )
 * @returns array of chunks; empty when `arr` is empty
 * @example
 * chunk([1, 2, 3, 4, 5], 2); // [[1, 2], [3, 4], [5]]
 */
export const chunk = <T>(arr: T[], size: number): T[][] => {
  if (size < 1) {
    throw new Error('chunk size must be >= 1');
  }

  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
};

/**
 * Returns a new array with duplicate values removed, preserving first-seen order.
 * Equality is by `Set` semantics ( `SameValueZero` ).
 *
 * @param arr - source array ( not mutated )
 * @example
 * unique([1, 1, 2, 3, 2]); // [1, 2, 3]
 */
export const unique = <T>(arr: T[]): T[] => Array.from(new Set(arr));

/**
 * Returns a new array with duplicates removed by a derived key, preserving first-seen order.
 * The key-based counterpart to {@link unique} ( equivalent to lodash `uniqBy` ).
 *
 * @param arr - source array ( not mutated )
 * @param keyFn - maps an element to the key used for equality
 * @example
 * uniqueBy([{ id: 1 }, { id: 1 }, { id: 2 }], (o) => o.id); // [{ id: 1 }, { id: 2 }]
 */
export const uniqueBy = <T, K>(arr: T[], keyFn: (item: T) => K): T[] => {
  const seen = new Set<K>();
  const out: T[] = [];
  for (const item of arr) {
    const key = keyFn(item);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
};

/**
 * Groups array elements into a `Map` keyed by the result of `keyFn`, preserving
 * insertion order within each group.
 *
 * @param arr - source array
 * @param keyFn - maps an element ( and its index ) to a group key
 * @returns a `Map` from key to the elements sharing it
 * @example
 * groupBy([1, 2, 3, 4], n => (n % 2 ? 'odd' : 'even'));
 * // Map { 'odd' => [1, 3], 'even' => [2, 4] }
 */
export const groupBy = <T, K>(arr: T[], keyFn: (item: T, index: number) => K): Map<K, T[]> => {
  const out = new Map<K, T[]>();
  arr.forEach((item, index) => {
    const key = keyFn(item, index);
    const bucket = out.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      out.set(key, [item]);
    }
  });
  return out;
};
