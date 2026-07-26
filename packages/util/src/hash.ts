/**
 * Tries to get value from hashmap, if missing calls onMissing callback and
 * sets result to hashmap
 *
 * @param hash hash map object
 * @param key key to find / set
 * @param onMissing  fallback called when key is missing in hash. returned value is inserted into hash
 * @returns hash value at given key
 */
export const tryGetHash = async <T, V>(hash: Map<T, V>, key: T, onMissing: () => Promise<V>) => {
  if (!hash.has(key)) {
    hash.set(key, await onMissing());
  }

  return hash.get(key);
};

/**
 * Synchronous variant of {@link tryGetHash}: returns the value at `key`, or computes it with
 * `onMissing`, stores it, and returns it.
 *
 * @param hash - map to read / populate
 * @param key - key to look up
 * @param onMissing - factory called ( once ) when the key is absent; its result is inserted
 * @returns the existing or newly-created value
 * @example
 * const counters = new Map<string, number>();
 * tryGetHashSync(counters, 'hits', () => 0); // -> 0, and stores it
 */
export const tryGetHashSync = <T, V>(hash: Map<T, V>, key: T, onMissing: () => V): V => {
  if (!hash.has(key)) {
    hash.set(key, onMissing());
  }

  return hash.get(key) as V;
};

/**
 * Alias-friendly helper: returns the value at `key`, inserting the result of `factory` when
 * absent. Identical to {@link tryGetHashSync} but named after the common "get or insert" idiom.
 *
 * @param hash - map to read / populate
 * @param key - key to look up
 * @param factory - factory producing the value to insert when the key is absent
 * @returns the existing or newly-created value
 */
export const getOrInsert = <T, V>(hash: Map<T, V>, key: T, factory: () => V): V => tryGetHashSync(hash, key, factory);
