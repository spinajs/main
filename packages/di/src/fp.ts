import { TypedArray } from './array.js';
import { AsyncService } from './interfaces.js';
import { RootContainer } from './root.js';
import { Class } from './types.js';

export function _resolve<T>(type: string, options?: unknown[], check?: boolean): () => T;
export function _resolve<T>(type: string, check?: boolean): () => T;
export function _resolve<T>(type: Class<T>, check?: boolean): () => T extends AsyncService ? Promise<T> : T;
export function _resolve<T>(type: TypedArray<T>, check?: boolean): () => T extends AsyncService ? Promise<T[]> : T[];
export function _resolve<T>(type: Class<T>, options?: unknown[] | boolean, check?: boolean): () => T extends AsyncService ? Promise<T> : T;
export function _resolve<T>(type: TypedArray<T>, options?: unknown[] | boolean, check?: boolean): () => T extends AsyncService ? Promise<T[]> : T[];
export function _resolve<T>(type: Class<T> | TypedArray<T> | string, options?: unknown[] | boolean, check?: boolean): () => Promise<T | T[]> | T | T[] {
  return () => RootContainer.resolve<T>(type, options, check);
}
