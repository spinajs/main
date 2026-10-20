import { Class } from './types.js';

declare global {
  interface ArrayConstructor {
    ofType<T>(type: Class<T> | string): TypedArray<T>;
    chainOf<T>(type: Class<T> | string): ChainArray<T>;
  }
}
export class TypedArray<R> extends Array<R> {
  constructor(public Type: Class<R> | string) {
    super();
  }
}

/**
 * Every registration of `Type` across the container and its ancestors. Unlike `Array.ofType`,
 * a child registration does not hide the parent's ones: ancestors come first, a class
 * registered under the same name lower in the lineage replaces the ancestor's one in place,
 * factories are always kept. Each element is resolved in the container that registered it,
 * except `PerChildContainer` types, which are resolved in the resolving container.
 */
export class ChainArray<R> extends TypedArray<R> {
  // Brands the type, so overloads tell it from a plain TypedArray.
  public readonly Chain = true;
}

// A second copy of this module in the process (another checkout's packages, the cjs and the mjs
// build side by side) must not swap these for its own classes: lists are told apart by class name.
Array.ofType ??= function <T>(type: Class<T> | string) {
  return new TypedArray<T>(type);
};

Array.chainOf ??= function <T>(type: Class<T> | string) {
  return new ChainArray<T>(type);
};
