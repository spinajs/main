import { Class } from './types.js';

declare global {
  interface ArrayConstructor {
    ofType<T>(type: Class<T> | string): TypedArray<T>;
  }
}
export class TypedArray<R> extends Array<R> {
  constructor(public Type: Class<R> | string) {
    super();
  }
}

Array.ofType = function <T>(type: Class<T> | string) {
  return new TypedArray<T>(type);
};
