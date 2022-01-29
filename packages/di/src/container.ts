import { InvalidArgument } from '@spinajs/exceptions';
import 'reflect-metadata';
import { TypedArray } from './array';
import { DI_DESCRIPTION_SYMBOL } from './decorators';
import { ResolveType } from './enums';
import { getTypeName, isAsyncModule, isFactory, uniqBy, isTypedArray } from './helpers';
import { IBind, IContainer, IInjectDescriptor, IResolvedInjection, SyncModule, IToInject, AsyncModule, ResolvableObject } from './interfaces';
import { Class, Factory } from './types';
import { EventEmitter } from 'events';
import { Binder } from './binder';
import { Registry } from './registry';
import { ContainerCache } from './container-cache';

/**
 * Dependency injection container implementation
 */
export class Container extends EventEmitter implements IContainer {
  /**
   * Handles information about what is registered as what
   * eg. that class IConfiguration should be resolved as DatabaseConfiguration etc.
   */
  private registry: Registry;

  /**
   * Singletons cache, objects that should be created only once are stored here.
   */
  private cache: ContainerCache;

  /**
   * Parent container if avaible
   */
  private parent: IContainer;

  /**
   * Returns container cache - map object with resolved classes as singletons
   */
  public get Cache() {
    return this.cache;
  }

  public get Registry() {
    return this.registry;
  }

  public get Parent() {
    return this.parent;
  }

  constructor(parent?: IContainer) {
    super();

    this.registry = new Registry(this);
    this.cache = new ContainerCache(this);
    this.parent = parent || undefined;
  }

  /**
   * Clears container registry and cache. shorthand for container.clearCache() && container.clearRegistry()
   */
  public clear() {
    this.clearCache();
  }

  /**
   * clears container registered types information
   */
  public clearCache(): void {
    this.cache.clear();
  }

  /**
   * Clears container resolved types
   */
  public clearRegistry(): void {
    this.Registry.clear();
  }

  /**
   * Register class/interface to DI.
   * @param type - interface object to register
   * @throws {@link InvalidArgument} if type is null or undefined
   */
  public register<T>(implementation: Class<T> | Factory<T> | ResolvableObject): IBind {
    if (!implementation) {
      throw new InvalidArgument('argument `type` cannot be null or undefined');
    }

    return new Binder(implementation, this);
  }

  /**
   * Creates child DI container.
   *
   */
  public child(): IContainer {
    return new Container(this);
  }

  /**
   * Gets already resolved services. Works only for singleton classes.
   *
   * Do not try to get service by factory func, it will always return null.
   * If you somehowe want to cache instances created by factory functions,
   * factory itself should do that somehow and end user should always resolve by
   * assigned type
   *
   * @param serviceName - name of service to get
   * @returns null if no service has been resolved at given name
   */
  public get<T>(service: TypedArray<T>, parent?: boolean): T[];
  public get<T>(service: string | Class<T>, parent?: boolean): T;
  public get<T>(service: string | Class<T> | TypedArray<T>, parent = true): T | T[] {
    const _get = (i: string) => {
      if (this.cache.has(i)) {
        return this.cache.get(i);
      } else if (this.parent && parent) {
        return this.parent.get(i, parent);
      }

      return null;
    };

    // get value registered as TypedArray ( mean to return all created instances )
    if (service instanceof TypedArray) {
      return _get(service.Type.name) as T[];
    }

    const rTypes = this.Registry.getTypes(service, parent);

    if (!rTypes) {
      // if nothing is registered as factory func or class
      // maybe we just added something to cache directly
      // eg. static object, number, etc
      if (typeof service === 'string') {
        return _get(service) as T;
      }

      return null;
    }

    /**
     * When we try to get type by factory func, always return null
     * It's technically an arror becouse factory func is in charge now
     * of managing intances of created objects (eg. creating cache)
     * and we treat them not as singletons
     *
     * We do not track of any instances created by factory funcions.
     */
    if (isFactory(rTypes[rTypes.length - 1])) {
      return null;
    }

    // lastly, try to get newest registered type
    // if eg. we registerd couple of types under same identifier
    // return last registered implementation
    return _get(rTypes[rTypes.length - 1].name) as T;
  }

  public hasRegistered<T>(service: Class<T> | string, parent = true): boolean {
    return this.Registry.hasRegistered(service, parent);
  }

  /**
   * Checks if service is already resolved and exists in container cache.
   * NOTE: check is only valid for classes that are singletons.
   *
   * @param service - service name or class to check
   * @returns true if service instance already exists, otherwise false.
   * @throws {@link InvalidArgument} when service is null or empty
   */
  public isResolved<T>(service: string | Class<T>, parent = true): boolean {
    return this.Cache.has(service, parent);
  }

  /**
   *
   * Resolves single instance of class
   *
   * @param type - what to resolve, can be class definition or factory function
   * @param options - options passed to constructor / factory
   */
  public resolve<T>(type: string, options?: unknown[], check?: boolean): T;
  public resolve<T>(type: string, check?: boolean): T;

  /**
   *
   * Resolves single instance of class
   *
   * @param type - what to resolve, can be class definition or factory function
   * @param options - options passed to constructor / factory
   */
  public resolve<T>(type: Class<T>, options?: unknown[], check?: boolean): T extends AsyncModule ? Promise<T> : T;
  public resolve<T>(type: Class<T>, check?: boolean): T extends AsyncModule ? Promise<T> : T;

  /**
   *
   * Resolves all instances of given class. Under single definition can be registered multiple implementations.
   *
   * @param type - typed array of specified type. since TS does not expose array metadata and type its uses TypedArray<T> consctruct
   * @param options - options passed to constructor / factory
   * @param check - strict check if serivice is registered in container before resolving. Default behavior is to not check and resolve
   *
   */
  public resolve<T>(type: TypedArray<T>, options?: unknown[], check?: boolean): T extends AsyncModule ? Promise<T[]> : T[];
  public resolve<T>(type: TypedArray<T>, check?: boolean): T extends AsyncModule ? Promise<T[]> : T[];

  /**
   *
   * @param type - type to resolve
   * @param options - options passed to constructor / factory
   * @param check - strict check if serivice is registered in container before resolving. Default behavior is to not check and resolve
   */
  public resolve<T>(type: Class<T> | TypedArray<T> | string, options?: unknown[] | boolean, check?: boolean): Promise<T | T[]> | T | T[] {
    if (!type) {
      throw new InvalidArgument('argument `type` cannot be null or undefined');
    }

    const sourceType = type instanceof TypedArray ? type.Type : type;
    const sourceName = getTypeName(type);
    const opt = typeof options === 'boolean' ? null : options;

    if (options === true || check === true) {
      if (!this.hasRegistered(sourceType)) {
        throw new Error(`Type ${sourceName} is not registered at container`);
      }
    }

    // if we do not have registered any types under
    // string identifier return null - we have nothing to resolve
    if (typeof type === 'string') {
      return null;
    }

    if (isTypedArray(type)) {
      // if its array type, resolve all registered types or type
      // used in typed array
      const targetType = this.getRegisteredTypes(type) ?? [type.Type];
      const resolved = targetType.map((r) => this.resolveType(sourceType, r, opt));
      if (resolved.some((r) => r instanceof Promise)) {
        return Promise.all(resolved) as Promise<T[]>;
      }

      return resolved as T[];
    } else {
      // finaly resolve single type:
      // 1. last registered type OR
      // 2. if non is registered - type itself

      const targetType = this.getRegisteredTypes(type) ?? [type];
      return this.resolveType(sourceType, targetType[targetType.length - 1], opt) as T;
    }
  }

  public getRegisteredTypes<T>(service: string | Class<T> | TypedArray<T>, parent?: boolean): (Class<unknown> | Factory<unknown>)[] {
    return this.Registry.getTypes(service, parent);
  }

  private resolveType<T>(sourceType: Class<T> | string, targetType: Class<T> | Factory<T>, options?: unknown[]): Promise<T> | T {
    /**
     * If its a factory func, always resolve as new instance
     */
    if (isFactory(targetType)) {
      return this.getNewInstance(targetType, null, options) as T;
    }

    // we now know its not factory func
    // but typescript complains about this
    // becouse isFactory is custom type check
    const tType = targetType;
    const sName = typeof sourceType === 'string' ? sourceType : sourceType.name;
    const descriptor = this.extractDescriptor(tType);

    // check if is singleton,
    // resolving strategy per container is treatead as singleton
    // in this particular container
    const isSingletonInChild = descriptor.resolver === ResolveType.PerChildContainer;
    const isSingleton = descriptor.resolver === ResolveType.Singleton;

    const setCache = (r: T) => {
      const toCheck = tType.name;

      this.Cache.add(toCheck, r);

      return r;
    };

    const getCachedInstance = (e: string | Class<unknown>, parent: boolean) => {
      if (this.isResolved(e, parent)) {
        return this.get(e, parent);
      }

      return null;
    };

    const resolve = (d: IInjectDescriptor<unknown>, t: Class<T>, i: IResolvedInjection[]) => {
      if (d.resolver === ResolveType.NewInstance) {
        return this.getNewInstance(t, i, options);
      }

      this.Registry.register(sName, t);
      return getCachedInstance(tType, d.resolver === ResolveType.Singleton ? true : false) || this.getNewInstance(t, i, options);
    };

    // check cache if needed
    if (isSingletonInChild || isSingleton) {
      // if its singleton ( not per child container )
      // check also in parent containers
      if (this.isResolved(tType, isSingleton)) {
        return this.get(tType) as unknown as T;
      }
    }

    const deps = this.resolveDependencies(descriptor.inject);

    if (deps instanceof Promise) {
      return deps
        .then((resolvedDependencies) => {
          return resolve(descriptor, tType, resolvedDependencies);
        })
        .then(setCache);
    } else {
      const resInstance = resolve(descriptor, tType, deps as IResolvedInjection[]);

      if (resInstance instanceof Promise) {
        return resInstance.then(setCache);
      }

      setCache(resInstance as T);
      return resInstance as T;
    }
  }

  protected getNewInstance(typeToCreate: Class<unknown> | Factory<unknown>, a?: IResolvedInjection[], options?: unknown[]): Promise<unknown> | unknown {
    let args: unknown[] = [null];
    let newInstance: unknown = null;

    /**
     * If type is not Constructable, we assume its factory function,
     * just call it with `this` container.
     */
    if (isFactory(typeToCreate)) {
      newInstance = typeToCreate(this, options);
    } else {
      if (a.constructor.name === 'Array') {
        args = args.concat(a.filter((i) => !i.autoinject).map((i) => i.instance));
      }

      if (options && options.length !== 0) {
        args = args.concat(options);
      }

      /* eslint-disable */
      newInstance = new (Function.prototype.bind.apply(typeToCreate, args))();

      for (const ai of a.filter((i) => i.autoinject)) {
        // TYPE HACK to tell typescript we dont care type
        /* eslint-disable */
        (newInstance as any)[`${ai.autoinjectKey}`] = ai.instance;
      }

      if (isAsyncModule(newInstance)) {
        return new Promise((res) => {
          (newInstance as AsyncModule)
            .resolveAsync()
            .then(() => {
              this.emit(`di.resolved.${typeToCreate.name}`);
            })
            .then(() => {
              res(newInstance);
            });
        });
      } else {
        if (newInstance instanceof SyncModule) {
          newInstance.resolve();
        }
        this.emit(`di.resolved.${typeToCreate.name}`);
      }
    }

    return newInstance;
  }

  public hasRegisteredType<T>(source: Class<T> | string, type: Class<T> | string | TypedArray<T>, parent?: boolean) {
    return this.Registry.hasRegisteredType(source, type, parent);
  }

  protected resolveDependencies(toInject: IToInject<unknown>[]) {
    const dependencies = toInject.map((t) => {
      const promiseOrVal = this.resolve(t.inject as any);
      if (promiseOrVal instanceof Promise) {
        return new Promise((res, _) => {
          res(promiseOrVal);
        }).then((val: any) => {
          return {
            autoinject: t.autoinject,
            autoinjectKey: t.autoinjectKey,
            instance: val,
          };
        });
      }
      return {
        autoinject: t.autoinject,
        autoinjectKey: t.autoinjectKey,
        instance: promiseOrVal,
      };
    });

    if (dependencies.some((p) => p instanceof Promise)) {
      return Promise.all(dependencies);
    }

    return dependencies;
  }

  protected extractDescriptor(type: Class<unknown>) {
    const descriptor: IInjectDescriptor<unknown> = {
      inject: [],
      resolver: ResolveType.Singleton,
    };

    reduce(type);

    descriptor.inject = uniqBy(descriptor.inject, (a, b) => {
      if (a.inject instanceof TypedArray && b.inject instanceof TypedArray) {
        return a.inject.Type.name === b.inject.Type.name;
      } else {
        return (a.inject as Class<unknown>).name === (b.inject as Class<unknown>).name;
      }
    });

    return descriptor;

    function reduce(t: Class<unknown>) {
      if (t) {
        // for descriptors defined on class declarations
        reduce((t as Function).prototype);

        // for descriptors defined on class properties eg. @Autoinject()
        reduce((t as any).__proto__);

        if ((t as any)[`${DI_DESCRIPTION_SYMBOL}`]) {
          descriptor.inject = descriptor.inject.concat((t as any)[`${DI_DESCRIPTION_SYMBOL}`].inject);
          descriptor.resolver = (t as any)[`${DI_DESCRIPTION_SYMBOL}`].resolver;
        }
      }
    }
  }
}
