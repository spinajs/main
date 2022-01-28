import { IContainer } from './interfaces';

/**
 * Abstract class type
 */
// tslint:disable-next-line: ban-types
export type Abstract<T = any> = Function & { prototype: T };
export type Constructor<T = any> = new (...args: any[]) => T;
export type Class<T = any> = Abstract<T> | Constructor<T>;

export type Factory<T> = (container: IContainer, ...args: any[]) => T;
export type ClassArray<T> = Class<T>[];
