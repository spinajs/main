import { InvalidArgument } from '@spinajs/exceptions';
import { uniqueBy } from '@spinajs/util';
import 'reflect-metadata';
import { ChainArray, TypedArray } from './array.js';
import { DI_DESCRIPTION_SYMBOL } from './decorators.js';
import { ResolveType } from './enums.js';
import { getTypeName, isAsyncService, isChainArray, isFactory, isTypedArray, isPromise } from './helpers.js';
import { IBind, IContainer, IInjectDescriptor, IResolvedInjection, SyncService, IToInject, AsyncService, ResolvableObject, Service, ResolveChainResult } from './interfaces.js';
import { Class, Factory, ResolveResult } from './types.js';
import { EventEmitter } from './events.js';
import { Binder } from './binder.js';
import { Registry } from './registry.js';
import { ContainerCache } from './container-cache.js';
import _ from 'lodash';
import { ServiceNotFound } from './exceptions.js';

/**
 * Maps `items` with `fn`. When `fn` throws synchronously, promises returned for the
 * earlier items get a no-op handler, so a later rejection is not reported as unhandled.
 */
function resolveEach<I>(items: I[], fn: (item: I) => unknown): unknown[] {
  const results: unknown[] = [];
  try {
    for (const item of items) {
      results.push(fn(item));
    }
  } catch (err) {
    results.filter((r) => isPromise(r)).forEach((p) => (p as Promise<unknown>).catch(() => undefined));
    throw err;
  }

  return results;
}

/**
 * The resolve strategy alone, as `extractDescriptor` reports it, without collecting the injections.
 */
function resolverOf(type: Class<unknown>): ResolveType {
  const meta = Reflect.getMetadata(DI_DESCRIPTION_SYMBOL, type) as IInjectDescriptor<unknown> | undefined;
  return meta ? meta.resolver : ResolveType.Singleton;
}

/**
 * A chain has no cache entry of its own: its elements are cached by the containers that own them.
 */
function rejectChain(service: unknown, method: string) {
  if (isChainArray(service)) {
    throw new InvalidArgument(`${method}() does not accept Array.chainOf(${getTypeName(service)}), use resolve()`);
  }
}

// A class goes by its name; a factory by its function name, which callers set with Object.defineProperty.
function registrationName(type: unknown): string {
  const name = (type as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

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
  private parent: IContainer | undefined;

  /**
   * Child containers created from this container
   */
  private children: Set<IContainer> = new Set();

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
    this.parent = parent;
  }

  /**
   * Clears container registry and cache. shorthand for container.clearCache() && container.clearRegistry()
   */
  public clear() {
    this.clearCache();
    this.clearRegistry();
  }

  public async dispose() {
    const disposalErrors: Error[] = [];

    // Dispose all children first
    await Promise.all([...this.children].map(child =>
      child.dispose().catch(err => {
        disposalErrors.push(err);
        // Continue with other children even if one fails
      })
    ));
    this.children.clear();

    // Dispose services in this container
    for (const entry of this.cache) {
      if (entry.value instanceof Service) {
        try {
          await entry.value.dispose();
        } catch (err: any) {
          disposalErrors.push(err);
          // Continue with other services even if one fails
        }
      }
    }

    this.clearCache();
    this.emit('di.dispose');

    // Log disposal errors if any occurred
    if (disposalErrors.length > 0) {
      console.warn(`${disposalErrors.length} services failed to dispose properly:`, disposalErrors);
    }
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
   * Get cache statistics for memory monitoring
   */
  public getCacheStats() {
    const entries: string[] = [];
    let size = 0;

    for (const entry of this.cache) {
      entries.push(entry.key);
      size++;
    }

    return {
      size,
      entries,
      childrenCount: this.children.size
    };
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
    const child = new Container(this);
    this.children.add(child);

    // Remove from parent when child is disposed
    child.once('di.dispose', () => {
      this.children.delete(child);
    });

    return child;
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
    rejectChain(service, 'get');

    // get value registered as TypedArray ( mean to return all created instances )
    if (service instanceof Array && service.constructor.name === 'TypedArray' || service instanceof TypedArray) {
      return this.cache.get(getTypeName(service.Type), parent) as T[];
    }

    const r = this.cache.get(this.getCurrentType(service, null as any, parent ?? true) ?? service, parent);
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
    rejectChain(service, 'isResolved');

    if (service instanceof Array && service.constructor.name === 'TypedArray' || service instanceof TypedArray) {
      return this.Cache.has(this.getCurrentType(service.Type, null as any, parent ?? true) ?? service, parent);
    }

    return this.Cache.has(this.getCurrentType(service, null as any, parent ?? true) ?? service, parent);
  }

  /**
   * Resolves `type` only when it is registered (here or in an ancestor), otherwise returns `undefined`.
   * Unlike `resolve`, it never falls back to instantiating the class itself.
   */
  public resolveOptional<T>(type: string, options?: unknown[]): T | undefined;
  public resolveOptional<T>(type: Class<T>, options?: unknown[]): ResolveResult<T> | undefined;
  public resolveOptional<T>(type: Class<T> | string, options?: unknown[]): unknown {
    return this.hasRegistered(type) ? this.resolve(type as Class<T>, options) : undefined;
  }

  public getRegisteredNames(base: Class<unknown>): string[] {
    const names = this.Registry.getTypesChain(base).map((e) => registrationName(e.type));
    return [...new Set(names.filter((n) => n !== ''))];
  }

  public async resolveNamed<T>(base: Class<T>, name: string): Promise<T> {
    const found = [...this.Registry.getTypesChain(base)].reverse().find((e) => registrationName(e.type) === name);
    if (!found) {
      throw new ServiceNotFound(`No ${base.name} is registered as "${name}"`);
    }

    // Unlike in a chain, a factory gets this container: it may read this container's configuration.
    return (isFactory(found.type) ? await (found.type as Factory<T>)(this) : await this.resolveChainClass(base, found.type as Class<T>, found.container as Container)) as T;
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
   * @param type - typed array of specified type. since TS does not expose array metadata and type its uses TypedArray<T> consctruct.
   *               `Array.chainOf(T)` merges the registrations of this container and its ancestors, and returns a promise
   *               when the base type or any element is an AsyncService, or when a resolution is pending
   * @param options - options passed to constructor / factory
   * @param check - strict check if serivice is registered in container before resolving. Default behavior is to not check and resolve
   *
   */
  public resolve<T>(type: ChainArray<T>, options?: unknown[], check?: boolean): ResolveChainResult<T>;
  public resolve<T>(type: ChainArray<T>, check?: boolean): ResolveChainResult<T>;
  public resolve<T>(type: TypedArray<T>, options?: unknown[], check?: boolean): T extends AsyncService ? Promise<T[]> : T[];
  public resolve<T>(type: TypedArray<T>, check?: boolean): T extends AsyncService ? Promise<T[]> : T[];

  /**
   *
   * @param type - type to resolve
   * @param options - options passed to constructor / factory
   * @param check - strict check if serivice is registered in container before resolving. Default behavior is not to check and resolve
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

    // Constructor options are not passed on: chain elements are resolved by many containers.
    if (isChainArray(type)) {
      return this.resolveChain(type) as any;
    }

    if (isTypedArray(type)) {
      const owner = this.findOwner(sourceName);
      if (owner !== this) {
        return this.resolveAncestorList(owner, type, opt ?? undefined) as any;
      }

      // if its array type, resolve all registered types or throw exception
      const targetType = this.getRegisteredTypes(type);

      // special case for arrays
      // return the cached collection, but ONLY when nothing new has been
      // registered since it was built - otherwise a type registered after the
      // first resolve would stay invisible forever. Factory registrations are
      // ignored here: they are never added to the cache, so counting them as
      // `new` would re-run every factory on each resolve.
      if (this.Cache.has(type)) {
        const cached = (this.Cache.get(type) ?? []) as unknown[];
        const hasUnresolved = (targetType ?? []).some((t) => !isFactory(t) && !cached.some((i) => (i as object)?.constructor === t));

        if (!hasUnresolved) {
          return cached as T[];
        }
      }

      if (!targetType) {
        return [];
      }

      const resolved = resolveEach(targetType, (r) => this.resolveType(type, r, opt ?? undefined));

      if (resolved.some((r) => r instanceof Promise)) {
        return Promise.all(resolved).then(() => this.get(type, false)) as any;
      }

      return this.get(type, false) as T[];
    } else {

      const fType = this.getCurrentType(type, tType, check ?? true);
      if (fType === null) {
        return null as any;
      }

      const rValue = this.resolveType(sourceType, fType, opt ?? undefined);
      return rValue as any;
    }
  }

  public getRegisteredTypes<T>(service: string | Class<T> | TypedArray<T>, parent?: boolean): (Class<unknown> | Factory<unknown>)[] {
    if (isChainArray(service)) {
      return this.Registry.getTypesChain(service).map((e) => e.type);
    }

    return this.Registry.getTypes(service, parent);
  }

  private resolveChain<T>(chain: ChainArray<T>): ResolveChainResult<T> {
    const type = chain.Type;

    // The service class (not the array) is the source so the Array.ofType
    // collection cache stays untouched.
    const resolved = resolveEach(this.Registry.getTypesChain(type), ({ type: entry, container }) => {
      const owner = container as Container;
      if (isFactory(entry)) {
        return owner.resolveType(type, entry as Factory<T>, undefined, true);
      }

      return this.resolveChainClass(type, entry as Class<T>, owner);
    });

    // An async element is a promise only on its first resolve; wrapping whenever
    // one is present keeps the result shape the same on every call.
    const isAsyncBase = typeof type !== 'string' && (type === AsyncService || type.prototype instanceof AsyncService);
    if (isAsyncBase || resolved.some((r) => isPromise(r) || isAsyncService(r))) {
      return Promise.all(resolved) as ResolveChainResult<T>;
    }

    return resolved as ResolveChainResult<T>;
  }

  /** A class of a chain resolves in the container that registered it, a PerChildContainer one in this container. */
  private resolveChainClass<T>(base: Class<T> | string, entry: Class<T>, owner: Container) {
    const target = owner.followRegistered(entry);
    const resolver = resolverOf(target) === ResolveType.PerChildContainer ? this : owner;
    return resolver.resolveType(base, target, undefined, true);
  }

  private getCurrentType<T>(type: Class<T> | string, tType?: Class<T>, check?: boolean) {
    // finaly resolve single type:
    // 1. last registered type OR
    // 2. if non is registered - type itself
    let targetType = this.getRegisteredTypes(type, check ?? true);

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
    // if we have override for target type in registry, resolve it ( last registered ) otherwise resolve target type type itself
    const fType = targetType[targetType.length - 1] ?? tType;
    return fType;
  }

  /**
   * Follows `last registered` links until they stabilize. Every @Injectable registers
   * under itself, so X -> [ X ] is the common fixed point. The seen-set guards against
   * registration cycles ( eg. A -> B -> C where C is self registered but never maps back to A ).
   */
  private followRegistered<T>(type: Class<T>): Class<T> {
    let tType = type;
    const seen = new Set<unknown>([tType]);
    for (;;) {
      const chained = this.Registry.getTypes(tType);
      if (!chained || chained.length === 0) {
        return tType;
      }

      const next = chained[chained.length - 1] as Class<T>;
      if (next === tType || seen.has(next)) {
        return tType;
      }

      // Keys are names: an ancestor's entry under this name is the ancestor's own class of
      // that name ( its self record ), not a redirect for a child class that replaces it.
      if (getTypeName(next) === getTypeName(tType) && !this.Registry.hasRegistered(tType, false)) {
        return tType;
      }

      seen.add(next);
      tType = next;
    }
  }

  /**
   * The container that owns the registration under `key`: the nearest one, starting at
   * this container, with its own registry entry for it. A key registered nowhere is
   * owned by this container.
   */
  private findOwner(key: string): Container {
    for (let c: IContainer | undefined = this; c; c = c.Parent) {
      if (c.Registry.ownsRegistration(key)) {
        return c as Container;
      }
    }

    return this;
  }

  /**
   * `Array.ofType` over a list registered in an ancestor. Without a PerChildContainer
   * element the owner resolves the whole list, so its collection cache serves this
   * container too. Otherwise each element is resolved where it lives: singletons in the
   * owner, the rest here. As with `Array.ofType` in the owner, factories and NewInstance
   * elements are created but left out of the result.
   */
  private resolveAncestorList<T>(owner: Container, type: TypedArray<T>, options?: unknown[]): T[] | Promise<T[]> {
    const entries = (owner.getRegisteredTypes(type, false) ?? []).map((t) => {
      if (isFactory(t)) {
        return { target: t as Factory<T>, resolver: null };
      }

      const target = owner.followRegistered(t as Class<T>);
      return { target, resolver: resolverOf(target) };
    });

    if (!entries.some((e) => e.resolver === ResolveType.PerChildContainer)) {
      return owner.resolve(type, options) as unknown as T[] | Promise<T[]>;
    }

    const kept = entries.map((e) => e.resolver !== null && e.resolver !== ResolveType.NewInstance);
    const resolved = resolveEach(entries, ({ target, resolver }) => {
      const inOwner = resolver === ResolveType.Singleton || resolver === ResolveType.PerInstance || resolver === ResolveType.PerInstanceCheck;
      return (inOwner ? owner : this).resolveType(type.Type, target, options, true);
    });

    // two registrations can lead to the same class, the owner's list holds it once
    const pick = (items: unknown[]) => [...new Set(items.filter((_, i) => kept[i]))] as T[];
    return resolved.some((r) => isPromise(r)) ? Promise.all(resolved).then(pick) : pick(resolved);
  }

  /**
   * @param exact - `targetType` is the final class and this container is where it lives:
   *                no owner lookup, no following of registrations, no registry write
   */
  private resolveType<T>(sourceType: Class<T> | string | TypedArray<T>, targetType: Class<T> | Factory<T>, options?: unknown[], exact = false): Promise<T> | T | Promise<T> | T[] {
    /**
     * If its a factory func, always resolve as new instance
     */
    if (isFactory(targetType)) {
      return this.getNewInstance(targetType, undefined, options) as T;
    }

    const sName = getTypeName(sourceType);
    const owner = exact ? this : this.findOwner(sName);
    const tType = exact ? (targetType as Class<T>) : owner.followRegistered(targetType as Class<T>);
    const descriptor = this.extractDescriptor(tType);

    // check if is singleton,
    // resolving strategy per container is treatead as singleton
    // in this particular container
    const isSingletonInChild = descriptor.resolver === ResolveType.PerChildContainer;
    const isSingleton = descriptor.resolver === ResolveType.Singleton || descriptor.resolver === ResolveType.PerInstanceCheck || descriptor.resolver === ResolveType.PerInstance;

    // A private instance of the class that this container already holds wins over the owner's.
    if (isSingleton && owner !== this && !this.Cache.has(tType)) {
      return owner.resolveType(sourceType, tType, options, true);
    }

    // A registry entry written into a non-owner would hide later registrations in the owner.
    const register = !exact && owner === this;
    const ownsKey = this.Registry.ownsRegistration(sName);

    // A container that registered the key itself must not pick up an ancestor's instance
    // that only shares the class name.
    const lookupParents = !ownsKey;

    const resolve = (d: IInjectDescriptor<unknown>, t: Class<T>, i: IResolvedInjection[]) => {
      if (d.resolver === ResolveType.NewInstance) {
        return this.getNewInstance(t, i, options);
      }

      if (register) {
        this.Registry.register(sName, t, !ownsKey);
      }

      // For singletons, don't check cache here - let getOrCreate handle it atomically
      return this.getNewInstance(t, i, options);

    };

    // For singletons, use atomic cache operations to prevent concurrent creation
    if (isSingletonInChild || isSingleton) {
      return this.Cache.getOrCreate(
        sourceType,
        tType,
        () => {
          const deps = this.resolveDependencies(descriptor.inject);

          if (deps instanceof Promise) {
            return deps.then((resolvedDependencies) => {
              return resolve(descriptor, tType, resolvedDependencies) as T;

            });
          } else {
            return resolve(descriptor, tType, deps as IResolvedInjection[]) as T;
          }
        },
        true, // isSingleton
        descriptor,
        options,
        lookupParents
      ) as T;
    }

    // Non-singleton path - resolve normally without caching.
    // Cache is bypassed here, so emit di.resolved events ourselves -
    // singleton path emits them from ContainerCache.getOrCreate
    const emitResolved = (instance: unknown) => {
      const targetName = getTypeName(tType);
      this.emit(`di.resolved.${targetName}`, this, instance);

      if (sName !== targetName) {
        this.emit(`di.resolved.${sName}`, this, instance);
      }

      return instance;
    };

    const deps = this.resolveDependencies(descriptor.inject);

    if (deps instanceof Promise) {
      return deps.then((resolvedDependencies) => {
        const resInstance = resolve(descriptor, tType, resolvedDependencies);
        return (isPromise(resInstance) ? resInstance.then(emitResolved) : emitResolved(resInstance)) as T;
      });
    } else {
      const resInstance = resolve(descriptor, tType, deps as IResolvedInjection[]);
      return (isPromise(resInstance) ? resInstance.then(emitResolved) : emitResolved(resInstance)) as T;
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
      if (a!.constructor.name === 'Array') {
        args = args.concat(a!.filter((i) => !i.autoinject).map((i) => i.instance));
      }

      if (options && options.length !== 0) {
        args = args.concat(options);
      }

      /* eslint-disable */
      newInstance = new (Function.prototype.bind.apply(typeToCreate, args as any))();

      for (const ai of a!.filter((i) => i.autoinject)) {
        // TYPE HACK to tell typescript we dont care type
        /* eslint-disable */
        (newInstance as any)[`${String(ai.autoinjectKey)}`] = ai.instance;
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
      if (t.resolveFunc) {
        const injected = (instance: unknown) => ({ autoinject: t.autoinject, autoinjectKey: t.autoinjectKey, instance });
        const value = t.resolveFunc(t.data, this);
        return isPromise(value) ? value.then(injected) : injected(value);
      }

      let tInject = null;

      // if we have service func, retrieve target
      // we can have multiple implementation of same interface
      // and service can request to inject specific one
      // ( not just last one registered )
      // if serviceFunc returns array,
      // all services will be resolved and mapped
      if (t.serviceFunc) {
        const services = t.serviceFunc(t.data, this);

        if (!services) {

          return {
            autoinject: t.autoinject,
            autoinjectKey: t.autoinjectKey,
            instance: undefined
          };
        }


        const types = this.getRegisteredTypes(t.inject);
        const findType = (name: string) => {
          const found = types.find((t) => t.name === name);
          if (!found) {
            throw new ServiceNotFound(`Service ${name} is not registered in DI container`);
          }

          return found;
        };

        if (!types || types.length === 0) {
          throw new ServiceNotFound(`Service ${(t.inject as any).name} is not registered in DI container`);
        }

        if (_.isArray(services)) {
          tInject = services.map((x) => {
            return {
              type: findType(x.service),
              options: x.options,
            };
          });
        } else {
          tInject = {
            type: findType(services.service),
            options: services.options,
          };
        }
      }

      let promiseOrVal = null;
      if (_.isArray(tInject)) {
        const pVals = tInject.map((x) => this.resolve(x.type as any, [t.options ?? x.options], false, x.type));
        if (pVals.some((x) => isPromise(x))) {
          promiseOrVal = Promise.all(pVals);
        } else {
          promiseOrVal = pVals;
        }
      } else {
        promiseOrVal = this.resolve((tInject?.type as any) ?? t.inject, [t.options ?? tInject?.options], false, tInject?.type);
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
      if (_.isArray(val) && t.mapFunc) {
        instance = new Map<string, unknown>();
        for (const i of val) {
          const key = t.mapFunc(i);
          if (key !== undefined) {
            (instance as Map<string, unknown>).set(key, i);
          }
        }
      }

      return instance;
    }
  }

  public extractDescriptor(type: Class<unknown>) {
    const descriptor: IInjectDescriptor<unknown> = {
      inject: [],
      resolver: ResolveType.Singleton,
    };

    const rootMeta = Reflect.getMetadata(DI_DESCRIPTION_SYMBOL, type) as IInjectDescriptor<unknown>;
    if (rootMeta) {
      descriptor.resolver = rootMeta.resolver;
    }

    // Array.ofType(T) and Array.chainOf(T) are different dependencies of one constructor.
    const injectKey = (x: IToInject<unknown>) => (isChainArray(x.inject) ? 'Array.chainOf:' : '') + getTypeName(x.inject);

    function geAllTypes(clz: Record<string, any>): void {
      if (!clz) return;
      const toInject: IInjectDescriptor<unknown> = Reflect.getMetadata(DI_DESCRIPTION_SYMBOL, clz);
      if (toInject) {
        toInject.inject.forEach((x) => {
          const xTypeName = injectKey(x);

          // if we do it by autoinject, skip filtering injection props
          // autoinject can have multiple fields of same type and its identified by prop key
          // we cannot override injection props in derived class
          if (x.autoinject === true) {
            descriptor.inject.push(x);
          } else if (descriptor.inject.find((i) => !i.autoinject && injectKey(i) === xTypeName) === undefined) {
            descriptor.inject.push(x);
          }
        });
      }

      // get `__proto__` and (recursively) all parent classes
      geAllTypes(Object.getPrototypeOf(clz));
    }

    geAllTypes(type);

    // remove duplicates
    // when we have multiple classes in hierarchy
    // with same injection types, we have to remove duplicates

    // constructor injects have no autoInject key, so we can filter them out
    // and add them first
    const constructorInject = descriptor.inject.filter((x) => x.autoinjectKey === '');
    const rest = descriptor.inject.filter((x) => x.autoinjectKey !== '');
    descriptor.inject = [...constructorInject, ...uniqueBy(rest, (x) => x.autoinjectKey)];

    return descriptor;
  }
}
