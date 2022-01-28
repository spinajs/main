import { Class } from './types';

declare global {
  interface ArrayConstructor {
    ofType<T>(type: Class<T>): TypedArray<T>;
  }
}
export class TypedArray<R> extends Array<R> {
  constructor(public Type: Class<R>) {
    super();
  }
}

Array.ofType = function <T>(type: Class<T>) {
  return new TypedArray<T>(type);
};
