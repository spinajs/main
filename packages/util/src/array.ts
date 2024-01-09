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
