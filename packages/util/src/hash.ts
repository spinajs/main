export namespace Util {
    export namespace Hash {

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
        }

    }
}