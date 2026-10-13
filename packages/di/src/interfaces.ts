/* eslint-disable @typescript-eslint/no-empty-function */
import { ResolveType } from './enums.js';
import { Class, Factory, InferClassOrFactory, InferTypedArray, ResolveResult, ResolveArrayResult } from './types.js';
import { EventEmitter } from './events.js';
import { ChainArray, TypedArray } from './array.js';
import { Registry } from './registry.js';
import { ContainerCache } from './container-cache.js';

export interface IInstanceCheck {
  __checkInstance__(creationOptions: any): boolean;
}

/**
 * Class info structure
 */
export class ClassInfo<T> {
  /**
   * Full file path of loaded class
   */
  public file: string;
  /**
   * Class name
   */
  public name: string;
  /**
   * Javascript class object
   */
  public type: any;

  /**
   * Resolved instance
   */
  public instance?: T;
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

/**
 * One registration of a service found while walking a container and its ancestors,
 * with the container that registered it.
 */
export interface IChainRegistration {
  type: Class<unknown> | Factory<unknown>;
  container: IContainer;
}

/**
 * A chain mixes implementations: an AsyncService base always yields a promise, any other
 * base yields one whenever an element is async.
 */
export type ResolveChainResult<T> = T extends AsyncService ? Promise<T[]> : T[] | Promise<T[]>;

export interface ResolvableObject {
  [key: string]: any;
}

export interface IContainer extends EventEmitter {
  Cache: ContainerCache;
  Registry: Registry;
  Parent: IContainer | undefined;

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
  /**
   * For `Array.chainOf(T)`: the registrations merged across this container and all its ancestors,
   * in the order `resolve(Array.chainOf(T))` returns their instances; `parent` is ignored.
   */
  getRegisteredTypes<T>(service: string | Class<T> | TypedArray<T>, parent?: boolean): Array<Class<unknown> | Factory<unknown>>;

  isResolved<T>(service: string | Class<T>, parent?: boolean): boolean;
  hasRegistered<T>(service: Class<T> | string | TypedArray<T>, parent?: boolean): boolean;
  hasRegisteredType<T>(source: Class<any> | string | TypedArray<any>, type: Class<T> | string | TypedArray<T> | object, parent?: boolean): boolean;

  resolve<T>(type: string, options?: unknown[], check?: boolean): T;
  resolve<T>(type: string, check?: boolean): T;
  resolve<T>(type: Class<T> | Factory<T>, check?: boolean): ResolveResult<T>;
  resolve<T>(type: Class<T> | Factory<T>, options?: unknown[] | boolean, check?: boolean): ResolveResult<T>;
  resolve<T>(type: ChainArray<T>, check?: boolean): ResolveChainResult<T>;
  resolve<T>(type: ChainArray<T>, options?: unknown[] | boolean, check?: boolean): ResolveChainResult<T>;
  resolve<T>(type: TypedArray<T>, check?: boolean): ResolveArrayResult<T>;
  resolve<T>(type: TypedArray<T>, options?: unknown[] | boolean, check?: boolean): ResolveArrayResult<T>;
  resolve<T extends Class<any> | Factory<any>>(type: T, options?: unknown[] | boolean, check?: boolean): ResolveResult<InferClassOrFactory<T>>;
  resolve<T extends TypedArray<any>>(type: T, options?: unknown[] | boolean, check?: boolean): ResolveArrayResult<InferTypedArray<T>>;
  resolve<T extends Class<any> | Factory<any>>(type: T, check?: boolean): ResolveResult<InferClassOrFactory<T>>;
  resolve<T extends TypedArray<any>>(type: T, check?: boolean): ResolveArrayResult<InferTypedArray<T>>;
  resolve(type: Class<any> | TypedArray<any> | string, options?: unknown[] | boolean, check?: boolean): unknown;

  /**
   * Resolves `type` only when it is registered (here or in an ancestor), otherwise returns `undefined`.
   * Unlike `resolve`, it never falls back to instantiating the class itself.
   */
  resolveOptional<T>(type: string, options?: unknown[]): T | undefined;
  resolveOptional<T>(type: Class<T>, options?: unknown[]): ResolveResult<T> | undefined;

  /**
   * Names of the registrations of `base` across this container and its ancestors (`Array.chainOf(base)`),
   * nearest container last, without repeats. A factory goes by its function name; an anonymous one is left out.
   */
  getRegisteredNames(base: Class<unknown>): string[];

  /**
   * The registration of `base` named `name`, nearest container first (see `getRegisteredNames`).
   * A factory is called with this container and its result is returned as is, undefined included. A class
   * resolves through DI, so its lifetime applies, in the container that registered it; a PerChildContainer
   * class resolves in this container.
   *
   * @throws ServiceNotFound when no registration has that name
   */
  resolveNamed<T>(base: Class<T>, name: string): Promise<T>;

  dispose(): Promise<void>;

  extractDescriptor(type: Class<unknown>): IInjectDescriptor<unknown>;
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
  autoinjectKey: string | symbol;

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
  serviceFunc?: (data: string | any[], container: IContainer) => IServiceFuncResult | IServiceFuncResult[] | undefined;
  mapFunc?: (x: any) => string | undefined;

  /**
   * Builds the injected value itself, from `data` and the resolving container; it may return a promise.
   * When set, `inject`, `serviceFunc` and `mapFunc` are not used to resolve it.
   */
  resolveFunc?: (data: any, container: IContainer) => unknown;
}

export interface IMappableService {
  ServiceName: string;
}

export interface IServiceFuncResult {
  service: string;
  options?: any;
}

export interface IResolvedInjection {
  instance: unknown;
  autoinject: boolean;
  autoinjectKey: string | symbol;
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
