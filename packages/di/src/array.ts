// tslint:disable-next-line: no-reference
/// <reference path="./../typings/array.d.ts" />

import { Class } from './types';

export class TypedArray<R> extends Array<R> {
  constructor(public Type: Class<R>) {
    super();
  }
}

// tslint:disable-next-line: only-arrow-functions
Array.ofType = function<T>(type: Class<T>) {
  return new TypedArray<T>(type);
};
