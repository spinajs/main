import type { IContainer, AsyncService } from './interfaces.js';

/* eslint-disable */
export type Abstract<T> = Function & { prototype: T };
export type Constructor<T> = new (...args: any[]) => T;
export type Class<T> = Abstract<T> | Constructor<T>;

/**
 * Factory functions should not be normal functions,
 * but arrow functions. Its is by js limitation
 * to detect if object is constructable
 */
export type Factory<T> = (container: IContainer, ...args: any[]) => T;
export type ClassArray<T> = Class<T>[];

/**
 * Extracts the instance type from a Class<T>, distributing over unions.
 * e.g. InferClass<Class<Foo> | Class<Bar>> = Foo | Bar
 */
export type InferClass<T> = T extends Class<infer U> ? U : never;

/**
 * Extracts the element type from a TypedArray<T>, distributing over unions.
 */
export type InferTypedArray<T> = T extends { Type: Class<infer U> | string } ? U : never;

/**
 * Distributive resolve result: wraps AsyncService members in Promise.
 * Distributes over union types automatically.
 */
export type ResolveResult<T> = T extends AsyncService ? Promise<T> : T;

/**
 * Distributive resolve result for arrays.
 */
export type ResolveArrayResult<T> = T extends AsyncService ? Promise<T[]> : T[];

/**
 * Extracts instance type from Class<T> or Factory<T>, distributing over unions.
 */
export type InferClassOrFactory<T> = T extends Class<infer U> ? U : T extends Factory<infer U> ? U : never;
