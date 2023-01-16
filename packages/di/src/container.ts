import { InvalidArgument } from '@spinajs/exceptions';
import 'reflect-metadata';
import { TypedArray } from './array';
import { DI_DESCRIPTION_SYMBOL } from './decorators';
import { ResolveType } from './enums';
import { getTypeName, isAsyncService, isFactory, uniqBy, isTypedArray, isPromise } from './helpers';
import { IBind, IContainer, IInjectDescriptor, IResolvedInjection, SyncService, IToInject, AsyncService, ResolvableObject, IInstanceCheck, Service } from './interfaces';
import { Class, Factory } from './types';
import { EventEmitter } from 'events';
import { Binder } from './binder';
import { Registry } from './registry';
import { ContainerCache } from './container-cache';
import { isArray } from 'lodash';
import { ResolveException, ServiceNotFound } from './exceptions';

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

  public async dispose() {
    for (const entry of this.cache) {
      if (entry.value instanceof Service) {
        await entry.value.dispose();
      }
    }

    this.clearCache();
    this.clearRegistry();

    this.emit('di.dispose');
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

  public unregister<T>(implementation: string | Class<T> | Factory<T> | ResolvableObject): void {
    if (!implementation) {
      throw new InvalidArgument('argument `type` cannot be null or undefined');
    }

    this.Registry.unregister(implementation);
  }

  public uncache<T>(implementation: string | Class<T> | TypedArray<T>, parent?: boolean): void {
    this.Cache.remove(implementation, parent);
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
    if (service instanceof Array && service.constructor.name === 'TypedArray') {
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
  public resolve<T>(type: string, options?: unknown[], check?: boolean, tType?: Class<T>): T;
  public resolve<T>(type: string, check?: boolean): T;

  /**
   *
   * Resolves single instance of class
   *
   * @param type - what to resolve, can be class definition or factory function
   * @param options - options passed to constructor / factory
   */
  public resolve<T>(type: Class<T>, options?: unknown[], check?: boolean): T extends AsyncService ? Promise<T> : T;
  public resolve<T>(type: Class<T>, check?: boolean): T extends AsyncService ? Promise<T> : T;

  /**
   *
   * Resolves all instances of given class. Under single definition can be registered multiple implementations.
   *
   * @param type - typed array of specified type. since TS does not expose array metadata and type its uses TypedArray<T> consctruct
   * @param options - options passed to constructor / factory
   * @param check - strict check if serivice is registered in container before resolving. Default behavior is to not check and resolve
   *
   */
  public resolve<T>(type: TypedArray<T>, options?: unknown[], check?: boolean): T extends AsyncService ? Promise<T[]> : T[];
  public resolve<T>(type: TypedArray<T>, check?: boolean): T extends AsyncService ? Promise<T[]> : T[];

  /**
   *
   * @param type - type to resolve
   * @param options - options passed to constructor / factory
   * @param check - strict check if serivice is registered in container before resolving. Default behavior is to not check and resolve
   */
  public resolve<T>(type: Class<T> | TypedArray<T> | string, options?: unknown[] | boolean, check?: boolean, tType?: Class<unknown>): Promise<T | T[]> | T | T[] {
    if (!type) {
      throw new InvalidArgument('argument `type` cannot be null or undefined');
    }

    // UGLY HACK ?
    // on electron instanceof TypedArray not working ?
    const sourceType = type instanceof Array && type.constructor.name === 'TypedArray' ? type.Type : type;
    const sourceName = getTypeName(type);
    const opt = typeof options === 'boolean' ? null : options;

    if (options === true || check === true) {
      if (!this.hasRegistered(sourceType as any)) {
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

      // if we have target function callback
      // we can select whitch of targetType to resolve
      //
      // if not, by default last registered type is resolved
      const fType = tType ?? targetType[targetType.length - 1];
      const rValue = this.resolveType(sourceType, fType, opt);
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
      const sourceTypeName = getTypeName(sourceType);
      const targetTypeName = getTypeName(targetType);

      // do not emit when we alrady created and cached value
      // ( resolve happends only once eg. for singletons)
      if (!this.Cache.has(targetTypeName)) {
        // firs event to emit that particular type was resolved
        this.emit(`di.resolved.${targetTypeName}`, this, target);

        // emit that source type was resolved
        if (targetTypeName !== sourceTypeName) {
          this.emit(`di.resolved.${sourceTypeName}`, this, target);
        }
      }
    };

    const getCachedInstance = (e: string | Class<any> | TypedArray<any>, parent: boolean) => {
      if (this.isResolved(e, parent)) {
        const rArray = this.get(e as any, parent);
        return isArray(rArray) ? rArray.find((x) => getTypeName(x) === getTypeName(targetType)) : rArray;
      }

      return null;
    };

    const getCachedInstances = (e: string | Class<any> | TypedArray<any>, parent: boolean) => {
      if (this.isResolved(e, parent)) {
        const rArray = this.get(e as any, parent);
        return isArray(rArray) ? rArray : [rArray];
      }

      return null;
    };

    const createNewInstance = (t: Class<T>, i: IResolvedInjection[], options: any) => {
      const instance = this.getNewInstance(t, i, options);
      if (isPromise(instance)) {
        return instance.then((r) => {
          emit(r);
          setCache(r);
          return r;
        });
      } else {
        emit(instance);
        setCache(instance as T);
        return instance;
      }
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

      if (d.resolver === ResolveType.PerInstanceCheck) {
        const cashed = getCachedInstances(tType, true);
        if (cashed) {
          const found = cashed.find((x) => {
            if (!(x as IInstanceCheck).__checkInstance__) {
              // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
              throw new ResolveException(`service ${x.constructor.name} is marked as PerInstanceCheck resolver, but no __checkInstance__ function is provided`);
            }
            return (x as IInstanceCheck).__checkInstance__(options);
          });
          if (found) {
            return found;
          } else {
            return createNewInstance(t, i, options);
          }
        }
      }

      this.Registry.register(sName, t);

      const cashed = getCachedInstance(tType, d.resolver === ResolveType.Singleton ? true : false);
      if (!cashed) {
        return createNewInstance(t, i, options);
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
      const cached = getCachedInstance(sourceType, isSingleton);
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

      if (isAsyncService(newInstance)) {
        return new Promise((res, rej) => {
          (newInstance as AsyncService)
            .resolve()
            .then(() => {
              res(newInstance);
            })
            .catch((err) => rej(err));
        });
      } else {
        if (newInstance instanceof SyncService) {
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
      let tInject = null;

      // if we have service func, retrieve target
      // we can have multiple implementation of same interface
      // and service can request to inject specific one
      // ( not just last one registered )
      // if serviceFunc returns array,
      // all services will be resolved and mapped
      if (t.serviceFunc) {
        const services = t.serviceFunc(t.data, this);

        const types = this.getRegisteredTypes(t.inject);

        if (!types || types.length === 0) {
          throw new ServiceNotFound(`Service ${(t.inject as any).name} is not registered in DI container`);
        }

        if (isArray(services)) {
          tInject = services.map((x) => {
            return {
              type: types.find((t) => t.name === x.service),
              options: x.options,
            };
          });
        } else {
          tInject = {
            type: types.find((t) => t.name === services.service),
            options: services.options,
          };
        }
      }

      let promiseOrVal = null;
      if (isArray(tInject)) {
        const pVals = tInject.map((x) => this.resolve(t.inject as any, [t.options ?? x.options], false, x.type));
        if (pVals.some((x) => isPromise(x))) {
          promiseOrVal = Promise.all(pVals);
        } else {
          promiseOrVal = pVals;
        }

        t.mapFunc = (x) => (x as any).Name || x.constructor.name;
      } else {
        promiseOrVal = this.resolve(t.inject as any, [t.options ?? tInject?.options], false, tInject?.type);
      }

      if (promiseOrVal instanceof Promise) {
        return promiseOrVal.then((val: any) => {
          return {
            autoinject: t.autoinject,
            autoinjectKey: t.autoinjectKey,
            instance: valOrMap(val, t),
          };
        });
      }

      return {
        autoinject: t.autoinject,
        autoinjectKey: t.autoinjectKey,
        instance: valOrMap(promiseOrVal, t),
      };
    });

    if (dependencies.some((p) => p instanceof Promise)) {
      return Promise.all(dependencies);
    }

    return dependencies;

    function valOrMap(val: any, t: IToInject<unknown>) {
      let instance = val;
      if (isArray(val) && t.mapFunc) {
        instance = new Map<string, unknown>();
        for (const i of val) {
          (instance as Map<string, unknown>).set(t.mapFunc(i), i);
        }
      }

      return instance;
    }
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
