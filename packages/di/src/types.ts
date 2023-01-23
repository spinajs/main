import { IContainer } from './interfaces.js';

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
