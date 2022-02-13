import { InvalidArgument } from '@spinajs/exceptions';
import 'reflect-metadata';
import { TypedArray } from './array';
import { DI_DESCRIPTION_SYMBOL } from './decorators';
import { ResolveType } from './enums';
import { getTypeName, isAsyncModule, isFactory, uniqBy, isTypedArray, isPromise } from './helpers';
import { IBind, IContainer, IInjectDescriptor, IResolvedInjection, SyncModule, IToInject, AsyncModule, ResolvableObject } from './interfaces';
import { Class, Factory } from './types';
import { EventEmitter } from 'events';
import { Binder } from './binder';
import { Registry } from './registry';
import { ContainerCache } from './container-cache';
import { isArray } from 'lodash';

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

  public unregister<T>(implementation: Class<T> | Factory<T> | ResolvableObject): void {
    if (!implementation) {
      throw new InvalidArgument('argument `type` cannot be null or undefined');
    }

    this.Registry.unregister(implementation);
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
    // get value registered as TypedArray ( mean to return all created instances )
    if (service instanceof TypedArray) {
      return this.cache.get(getTypeName(service.Type)) as T[];
    }

    const r = this.cache.get(service, parent);
    return r[r.length - 1] as T;
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
  public isResolved<T>(service: string | Class<T> | TypedArray<T>, parent = true): boolean {
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

    if (isTypedArray(type)) {
      // special case for arrays
      // if we have in cache, retunr all we got
      // TODO: fix this and every time check if theres is any
      // new registerd type
      if (this.Cache.has(type)) {
        return this.Cache.get(type);
      }

      // if its array type, resolve all registered types or throw exception
      const targetType = this.getRegisteredTypes(type);

      if (!targetType) {
        return [];
      }

      const resolved = targetType.map((r) => this.resolveType(type, r, opt));
      if (resolved.some((r) => r instanceof Promise)) {
        return Promise.all(resolved) as any;
      }
      return resolved as T[];
    } else {
      // finaly resolve single type:
      // 1. last registered type OR
      // 2. if non is registered - type itself
      let targetType = this.getRegisteredTypes(type);

      if (!targetType) {
        // if nothing is register under string identifier, then return null
        if (typeof type === 'string') {
          return null;
        } else {
          targetType = [type];
        }
      }

      // resolve last registered type ( newest )
      const rValue = this.resolveType(sourceType, targetType[targetType.length - 1], opt);
      return rValue as any;
    }
  }

  public getRegisteredTypes<T>(service: string | Class<T> | TypedArray<T>, parent?: boolean): (Class<unknown> | Factory<unknown>)[] {
    return this.Registry.getTypes(service, parent);
  }

  private resolveType<T>(sourceType: Class<T> | string | TypedArray<T>, targetType: Class<T> | Factory<T>, options?: unknown[]): Promise<T> | T | Promise<T> | T[] {
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
    const sName = getTypeName(sourceType);
    const descriptor = this.extractDescriptor(tType);

    // check if is singleton,
    // resolving strategy per container is treatead as singleton
    // in this particular container
    const isSingletonInChild = descriptor.resolver === ResolveType.PerChildContainer;
    const isSingleton = descriptor.resolver === ResolveType.Singleton;

    const setCache = (target: T) => {
      this.Cache.add(sourceType, target);
      return target;
    };
    const emit = (target: any) => {
      // do not emit when we alrady created and cached value
      // ( resolve happends only once eg. for singletons)
      if (!this.Cache.has(getTypeName(target))) {
        // firs event to emit that particular type was resolved
        this.emit(`di.resolved.${getTypeName(target)}`, this, target);

        // emit that source type was resolved
        this.emit(`di.resolved.${getTypeName(sourceType)}`, this, target);
      }
    };

    const getCachedInstance = (e: string | Class<any> | TypedArray<any>, parent: boolean) => {
      if (this.isResolved(e, parent)) {
        const rArray = this.get(e as any, parent);
        return isArray(rArray) ? rArray.find((x) => getTypeName(x) === getTypeName(targetType)) : rArray;
      }

      return null;
    };

    const resolve = (d: IInjectDescriptor<unknown>, t: Class<T>, i: IResolvedInjection[]) => {
      if (d.resolver === ResolveType.NewInstance) {
        const instance = this.getNewInstance(t, i, options);

        if (isPromise(instance)) {
          return instance.then((r) => {
            emit(r);
            return r;
          });
        } else {
          emit(instance);
          return instance;
        }
      }

      this.Registry.register(sName, t);

      const cashed = getCachedInstance(tType, d.resolver === ResolveType.Singleton ? true : false);
      if (!cashed) {
        const instance = this.getNewInstance(t, i, options);
        if (isPromise(instance)) {
          return instance.then((r) => {
            setCache(r);
            emit(r);
            return r;
          });
        } else {
          setCache(instance as T);
          emit(instance);
          return instance;
        }
      } else {
        return cashed;
      }
    };

    // check cache if needed
    if (isSingletonInChild || isSingleton) {
      // if its singleton ( not per child container )
      // check also in parent containers

      // ------- IMPORTANT ------------
      // TODO: in future allow to check in runtime if target type is cashed,
      // now, if for example we resolve array of some type,
      // when we later register another type of base class used in typed array
      // we will not resolve it, becaouse contaienr will not check
      // if in cache this new type exists ( only check if type in array exists )
      const cached = getCachedInstance(sourceType, isSingleton) as any;
      if (cached) {
        return cached;
      }
    }

    const deps = this.resolveDependencies(descriptor.inject);

    if (deps instanceof Promise) {
      return deps.then((resolvedDependencies) => {
        return resolve(descriptor, tType, resolvedDependencies) as T;
      });
    } else {
      const resInstance = resolve(descriptor, tType, deps as IResolvedInjection[]);

      if (resInstance instanceof Promise) {
        return resInstance;
      }
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
      newInstance = typeToCreate(this, ...(options ?? []));
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
        return new Promise((res, rej) => {
          (newInstance as AsyncModule)
            .resolveAsync()
            .then(() => {})
            .then(() => {
              res(newInstance);
            })
            .catch((err) => rej(err));
        });
      } else {
        if (newInstance instanceof SyncModule) {
          newInstance.resolve();
        }
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
        return getTypeName(a.inject.Type) === getTypeName(b.inject.Type);
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
