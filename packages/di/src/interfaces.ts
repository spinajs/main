import { ResolveType } from './enums';
import { Class, Factory } from './types';
import { EventEmitter } from 'events';
import { TypedArray } from './array';
import { Registry } from './registry';
import { ContainerCache } from './container-cache';

/**
 * Interface to describe DI binding behaviour
 */
export interface IBind {
  /**
   * `as` binding (alias)
   *
   * @param type - base class that is being registered
   */
  as(type: Class<any> | string): this;

  /**
   * self bind, class should be resolved by its name. Its default behaviour.
   */
  asSelf(): this;

  /**
   * Registers as value, it wont be resolved or called, just stored as is in container
   *
   * @param type - name of type / key after whitch implementation will be resolved
   */
  asValue(type: string): this;

  /**
   * Registers object as single instance ( singleton )
   */
  singleInstance(): this;
}

export interface ResolvableObject {
  [key: string]: any;
}

export interface IContainer extends EventEmitter {
  Cache: ContainerCache;
  Registry: Registry;
  Parent: IContainer;

  clear(): void;
  clearRegistry(): void;
  clearCache(): void;

  register<T>(implementation: Class<T> | Factory<T> | ResolvableObject): IBind;
  unregister<T>(implementation: Class<T> | Factory<T> | ResolvableObject): void;
  uncache<T>(source: string | Class<T> | TypedArray<T>, parent?: boolean): void;

  child(): IContainer;
  get<T>(service: TypedArray<T>, parent?: boolean): T[] | null;
  get<T>(service: string | Class<T>, parent?: boolean): T | null;
  get<T>(service: string | Class<T> | TypedArray<T>, parent?: boolean): T | T[] | null;
  getRegisteredTypes<T>(service: string | Class<T> | TypedArray<T>, parent?: boolean): Array<Class<unknown> | Factory<unknown>>;

  isResolved<T>(service: string | Class<T>, parent?: boolean): boolean;
  hasRegistered<T>(service: Class<T> | string | TypedArray<T>, parent?: boolean): boolean;
  hasRegisteredType<T>(source: Class<any> | string | TypedArray<any>, type: Class<T> | string | TypedArray<T> | object, parent?: boolean): boolean;

  resolve<T>(type: string, options?: unknown[], check?: boolean): T;
  resolve<T>(type: string, check?: boolean): T;
  resolve<T>(type: Class<T> | Factory<T>, options?: unknown[] | boolean, check?: boolean): T extends AsyncModule ? Promise<T> : T;
  resolve<T>(type: TypedArray<T>, options?: unknown[] | boolean, check?: boolean): T extends AsyncModule ? Promise<T[]> : T[];
  resolve<T>(type: Class<T> | Factory<T>, check?: boolean): T extends AsyncModule ? Promise<T> : T;
  resolve<T>(type: TypedArray<T>, check?: boolean): T extends AsyncModule ? Promise<T[]> : T[];
  resolve<T>(type: Class<T> | TypedArray<T> | string, options?: unknown[] | boolean, check?: boolean): Promise<T | T[]> | T | T[];
}

/**
 * Injection description definition structure
 */
export interface IInjectDescriptor<T> {
  inject: IToInject<T>[];
  resolver: ResolveType;
}

export interface IToInject<T> {
  inject: Class<T> | TypedArray<T>;
  autoinject: boolean;
  autoinjectKey: string;
}

export interface IResolvedInjection {
  instance: unknown;
  autoinject: boolean;
  autoinjectKey: string;
}

/**
 * Interface to describe DI resolve strategies. Strategies are used do
 * do some work at object creation eg. initialize objects that inherits from same class
 * specific way but without need for factory function.
 *
 *
 * @see FrameworkModuleSyncModule implementation
 */
// export interface IStrategy {
//     resolve: (target: any, container: IContainer) => void;
// }

// export interface IAsyncStrategy {
//     resolveA: (target: any, container: IContainer) => Promise<void>;
// }

export class Module {
  protected resolved = false;
  public get Resolved(): boolean {
    return this.resolved;
  }
}

export abstract class SyncModule extends Module {
  public resolve() {
    this.resolved = true;
  }
}

export class AsyncModule extends Module {
  /* eslint-disable */
  public async resolveAsync(): Promise<void> {
    this.resolved = true;
  }
}

export abstract class Bootstrapper {
  public abstract bootstrap(): Promise<void> | void;
}
