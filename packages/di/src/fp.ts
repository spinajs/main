import { TypedArray } from './array.js';
import { RootContainer } from './root.js';
import { Class, InferClass, InferTypedArray, ResolveResult, ResolveArrayResult } from './types.js';

export function _resolve<T>(type: string, options?: unknown[], check?: boolean): () => T;
export function _resolve<T>(type: string, check?: boolean): () => T;
export function _resolve<T>(type: Class<T>, check?: boolean): () => ResolveResult<T>;
export function _resolve<T>(type: Class<T>, options?: unknown[] | boolean, check?: boolean): () => ResolveResult<T>;
export function _resolve<T>(type: TypedArray<T>, check?: boolean): () => ResolveArrayResult<T>;
export function _resolve<T>(type: TypedArray<T>, options?: unknown[] | boolean, check?: boolean): () => ResolveArrayResult<T>;
export function _resolve<T extends Class<any>>(type: T, check?: boolean): () => ResolveResult<InferClass<T>>;
export function _resolve<T extends TypedArray<any>>(type: T, check?: boolean): () => ResolveArrayResult<InferTypedArray<T>>;
export function _resolve<T extends Class<any>>(type: T, options?: unknown[] | boolean, check?: boolean): () => ResolveResult<InferClass<T>>;
export function _resolve<T extends TypedArray<any>>(type: T, options?: unknown[] | boolean, check?: boolean): () => ResolveArrayResult<InferTypedArray<T>>;
export function _resolve(type: Class<any> | TypedArray<any> | string, options?: unknown[] | boolean, check?: boolean): () => unknown {
  return () => RootContainer.resolve(type as any, options, check);
}
