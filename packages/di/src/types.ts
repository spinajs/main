import { IContainer } from './interfaces';

/* eslint-disable */
export type Abstract<T> = Function & { prototype: T };
export type Constructor<T> = new (...args: any[]) => T;
export type Class<T> = Abstract<T> | Constructor<T>;

export type Factory<T> = (container: IContainer, ...args: any[]) => T;
export type ClassArray<T> = Class<T>[];
