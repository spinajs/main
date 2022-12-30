/* eslint-disable @typescript-eslint/no-empty-function */
import { ResolveType } from './enums';
import { Class, Factory } from './types';
import { EventEmitter } from 'events';
import { TypedArray } from './array';
import { Registry } from './registry';
import { ContainerCache } from './container-cache';

export interface IInstanceCheck {
  __checkInstance__(creationOptions: any): boolean;
}

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
   * @param type - name of type / key after whitch implementation will be resolved
   * @param override - if true, any value registered before is overriden by new one
   */
  asValue(type: string, override: boolean): this;
  asValue(type: string): this;

  /**
   *
   * Add plain value to container, value is stored in hashmap for quick access
   * eg. we have multiple value converters and we wanc o(1) access, instead searching for
   * converter for specific type
   *
   * @param type - name of added value
   * @param key - hashmap key
   */
  asMapValue(type: string, hashKey: string): this;

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
  unregister<T>(implementation: string | Class<T> | Factory<T> | ResolvableObject): void;
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
  resolve<T>(type: Class<T> | Factory<T>, options?: unknown[] | boolean, check?: boolean): T extends AsyncService ? Promise<T> : T;
  resolve<T>(type: TypedArray<T>, options?: unknown[] | boolean, check?: boolean): T extends AsyncService ? Promise<T[]> : T[];
  resolve<T>(type: Class<T> | Factory<T>, check?: boolean): T extends AsyncService ? Promise<T> : T;
  resolve<T>(type: TypedArray<T>, check?: boolean): T extends AsyncService ? Promise<T[]> : T[];
  resolve<T>(type: Class<T> | TypedArray<T> | string, options?: unknown[] | boolean, check?: boolean): Promise<T | T[]> | T | T[];

  dispose(): Promise<void>;
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

  /**
   * additional data passed to DI when resolving
   */
  data?: any;

  /**
   * Additional options passed to resolved options
   */
  options?: any;

  /**
   * Callback used to resolve service
   * name of service we want to resolve
   * eg. we have multiple \@injectable registered
   * and we want specific one
   *
   * It is specifically for use with configuration module
   * where services can be changed in configuration files
   * and allows to use @AutoinjectService() decorator
   */
  serviceFunc?: (data: string | any[], container: IContainer) => IServiceFuncResult | IServiceFuncResult[];
  mapFunc?: (x: unknown) => string;
}

export interface IServiceFuncResult {
  service: string;
  options?: any;
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
 * @see FrameworkModuleSyncService implementation
 */
// export interface IStrategy {
//     resolve: (target: any, container: IContainer) => void;
// }

// export interface IAsyncStrategy {
//     resolveA: (target: any, container: IContainer) => Promise<void>;
// }

export class Service {
  protected resolved = false;
  public get Resolved(): boolean {
    return this.resolved;
  }

  /**
   * Use to dispose service, relase all resources, stop timers etc.
   *
   */
  public async dispose() {}
}

export abstract class SyncService extends Service {
  public resolve() {
    this.resolved = true;
  }
}

export class AsyncService extends Service {
  /* eslint-disable */
  public async resolve(): Promise<void> {
    this.resolved = true;
  }
}

export abstract class Bootstrapper {
  public abstract bootstrap(): Promise<void> | void;
}

export interface IAutoinjectOptions<T> {
  mapFunc?: (x: T) => string;
  options?: any;
}
