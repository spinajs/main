import _ from 'lodash';
import { TypedArray } from './array.js';
import { getTypeName, isTypedArray } from './helpers.js';
import { IContainer, IInjectDescriptor, IInstanceCheck, Service } from './interfaces.js';
import { Class } from './types.js';
import { ResolveType } from './enums.js';
import { ResolveException } from './exceptions.js';
 

export class ContainerCache {
  private cache: Map<string, any[]>;
  // Track ongoing resolution promises to prevent concurrent singleton creation
  private resolutionPromises: Map<string, Promise<any>> = new Map();
  // Track keys currently being created synchronously
  private creatingKeys: Set<string> = new Set();
  private pendingChecked: Map<string, { options?: unknown[]; promise: Promise<unknown> }[]> = new Map();
  // Bumped whenever the tracked resolutions are dropped, so a creation that finishes later cannot write into the new state.
  private epoch = 0;

  constructor(private container: IContainer) {
    this.cache = new Map<string, any[]>();

    this.addSelf();
  }

  // Under `Container` too, so a subclass instance is what `@Autoinject(Container)` gets.
  private addSelf() {
    this.add(this.container, this.container);
    this.add('Container', this.container);
  }

  *[Symbol.iterator]() {
    for (const [key, value] of this.cache) {
      for (const v of value) {
        yield { key, value: v };
      }
    }
  }

  public remove(key: string | Class<any> | TypedArray<any>, parent?: boolean): void {
    const name = getTypeName(key);
    const ownInstance = this.cache.delete(name);
    const ownValue = this.container.Registry.removeValue(name);
    if (!ownInstance && !ownValue && parent && this.container.Parent) {
      this.container.Parent.uncache(key);
    }
  }

  public add(key: string | Class<any> | object, instance: any) {
    const tName = getTypeName(key);
    const list = this.cache.get(tName);

    if (!list) {
      this.cache.set(tName, [instance]);
    } else if (!list.includes(instance)) {
      list.push(instance);
    }
  }

  /**
   * Add instance to cache only if it doesn't already exist (atomic operation for singletons)
   */
  public addIfNotExists(key: string | Class<any> | object, instance: any): boolean {
    const tName = getTypeName(key);

    if (this.has(key)) {
      return false;
    }

    this.cache.set(tName, [instance]);
    return true;
  }

  public has(key: string | Class<any> | object | TypedArray<any>, parent?: boolean): boolean {
    const name = getTypeName(key);
    if (this.cache.has(name) || this.container.Registry.hasValue(name)) {
      return true;
    }

    if (parent && this.container.Parent) {
      return this.container.Parent.Cache.has(key, parent);
    }

    return false;
  }

  /** Cached instances under `key` win over values registered under the same key. */
  public get(key: string | Class<any> | TypedArray<any>, parent?: boolean): any {
    const name = getTypeName(key);
    const found = this.cache.get(name) ?? this.container.Registry.getValues(name);
    if (found) {
      return found;
    }

    if (parent && this.container.Parent) {
      return this.container.Parent.Cache.get(key, parent);
    }

    return [];
  }

  /**
   * Atomic get-or-create operation for singleton services
   * Prevents concurrent creation of the same singleton instance
   */
  public getOrCreate<T>(
    sourceType: string | Class<any> | TypedArray<any> | object,
    targetType: string | Class<any> | TypedArray<any>,
    factory: () => Promise<T> | T,
    isSingleton: boolean = true,
    descriptor: IInjectDescriptor<unknown>,
    options?: unknown[],
    lookupParents = true
  ): Promise<T> | T {
    const keyName = getTypeName(targetType);
    const sourceTypeKey = getTypeName(sourceType);

    const emit = (target: any) => {
      const sourceTypeName = getTypeName(sourceType);
      const targetTypeName = getTypeName(targetType);

      // firs event to emit that particular type was resolved
      this.container.emit(`di.resolved.${targetTypeName}`, this.container, target);

      // emit that source type was resolved
      if (targetTypeName !== sourceTypeName) {
        this.container.emit(`di.resolved.${sourceTypeName}`, this.container, target);
      }
    };

    const perInstanceCheck = descriptor.resolver === ResolveType.PerInstanceCheck;
    if (perInstanceCheck && !isTypedArray(sourceType)) {
      return this.getOrCreateChecked(targetType, factory, emit, options, lookupParents);
    }

    // Fast path: return cached instance if it exists
    const parent = lookupParents && descriptor.resolver !== ResolveType.PerChildContainer;
    if (this.has(targetType, parent)) {
      const cached = this.get(targetType, parent);

      if (perInstanceCheck) {
        const found = cached.find((x: unknown) => this.checkInstance(x, options));
        if (found) {
          return found;
        }
      } else {
        const instance = Array.isArray(cached) ? cached[0] : cached;

        // Resolving a collection ( Array.ofType(Base) ) over a type that already
        // sits in the cache under its own key must still contribute it to the
        // collection - otherwise the fast path returns early and the type is
        // silently MISSING from the resolved array.
        if (isTypedArray(sourceType) && getTypeName(targetType) !== sourceTypeKey) {
          this.add(sourceTypeKey, instance);
        }

        return instance;
      }
    }

    // For non-singletons, always create new instance
    if (!isSingleton) {
      return factory();
    }

    // Check if creation is already in progress (async)
    if (this.resolutionPromises.has(keyName)) {
      const pending = this.resolutionPromises.get(keyName)!;
      if (perInstanceCheck) {
        // the pending instance may have been built for other options, check again once it settles
        const retry = () => this.getOrCreate(sourceType, targetType, factory, isSingleton, descriptor, options, lookupParents);
        return pending.then(retry, retry);
      }
      return pending;
    }

    // Check if creation is already in progress (sync)
    if (this.creatingKeys.has(keyName)) {
      // This indicates a potential circular dependency or re-entrant call
      if (this.has(targetType)) {
        const cached = this.get(targetType);
        return Array.isArray(cached) ? cached[0] : cached;
      }
      throw new Error(`Circular dependency detected for ${keyName}`);
    }

    // Mark this key as being created to prevent re-entrance
    this.creatingKeys.add(keyName);

    let instance: Promise<T> | T;
    try {
      instance = factory();
    } catch (error) {
      this.creatingKeys.delete(keyName);
      throw error;
    }

    const _checkCache = (resolvedInstance: T) => {
      if (isTypedArray(sourceType)) {
        // Through add(), never by pushing into get()'s result: that can be the registry's value list.
        if (!this.get(sourceTypeKey).includes(resolvedInstance)) {
          this.add(sourceTypeKey, resolvedInstance);
          emit(resolvedInstance);
        }
        // Also cache under the concrete type. Resolving a collection
        // ( eg. Array.ofType(BaseController) ) used to register the instance
        // ONLY under the element type key, so a later get/resolve by the
        // concrete type missed the cache - returning undefined from get(), and
        // silently constructing a SECOND instance from resolve(). Same
        // instance, second key - no extra construction.
        if (getTypeName(targetType) !== sourceTypeKey && !this.has(targetType)) {
          this.add(targetType, resolvedInstance);
        }

        const cached = this.get(sourceTypeKey);
        return isTypedArray(sourceType) ? cached : cached[0];
      } else {
        // Cache the instance if not already cached
        if (!this.has(targetType)) {
          this.add(targetType, resolvedInstance);
          emit(resolvedInstance); 
        }
      }

      // Return the cached version
      const cached = this.get(targetType);
      return cached[0];
    }

    // If factory returns a Promise, handle async resolution
    if (instance instanceof Promise) {
      const epoch = this.epoch;
      const creation = instance.then(resolvedInstance => {
        if (epoch !== this.epoch) {
          return this.discardLate(keyName, resolvedInstance);
        }
        this.creatingKeys.delete(keyName);
        this.resolutionPromises.delete(keyName);

        return _checkCache(resolvedInstance);

      }).catch(error => {
        if (epoch === this.epoch) {
          this.creatingKeys.delete(keyName);
          this.resolutionPromises.delete(keyName);
        }
        throw error;
      });

      // Store the promise to prevent concurrent resolutions
      this.resolutionPromises.set(keyName, creation);
      return creation;
    } else {
      // Synchronous resolution
      this.creatingKeys.delete(keyName);
      return _checkCache(instance);
    }
  }

  private checkInstance(instance: unknown, options?: unknown[]): boolean {
    if (!(instance as IInstanceCheck).__checkInstance__) {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      throw new ResolveException(`service ${(instance as any).constructor.name} is marked as PerInstanceCheck resolver, but no __checkInstance__ function is provided`);
    }
    return (instance as IInstanceCheck).__checkInstance__(options);
  }

  /**
   * Every instance is cached, so each distinct option set resolves to one instance and is disposed
   * with the container. A creation in flight has no instance to check yet, so concurrent
   * resolutions share it only when their options are deep-equal.
   */
  private getOrCreateChecked<T>(
    targetType: string | Class<any> | TypedArray<any>,
    factory: () => Promise<T> | T,
    emit: (instance: unknown) => void,
    options?: unknown[],
    lookupParents = true,
  ): Promise<T> | T {
    const keyName = getTypeName(targetType);
    const cached: unknown[] = this.has(targetType, lookupParents) ? this.get(targetType, lookupParents) : [];
    const found = cached.find((x) => this.checkInstance(x, options));
    if (found) {
      return found as T;
    }

    const pending = this.pendingChecked.get(keyName) ?? [];
    const same = pending.find((p) => _.isEqual(p.options, options));
    if (same) {
      return same.promise as Promise<T>;
    }

    const store = (instance: T) => {
      this.add(targetType, instance);
      emit(instance);
      return instance;
    };

    const created = factory();
    if (!(created instanceof Promise)) {
      return store(created);
    }

    const epoch = this.epoch;
    const entry: { options?: unknown[]; promise: Promise<unknown> } = { options, promise: created };
    const settle = () => {
      const list = this.pendingChecked.get(keyName) ?? [];
      const rest = list.filter((p) => p !== entry);
      if (rest.length) this.pendingChecked.set(keyName, rest);
      else this.pendingChecked.delete(keyName);
    };
    entry.promise = created.then(
      (instance) => {
        settle();
        return epoch === this.epoch ? store(instance) : this.discardLate(keyName, instance);
      },
      (err) => {
        settle();
        throw err;
      },
    );
    this.pendingChecked.set(keyName, [...pending, entry]);
    return entry.promise as Promise<T>;
  }

  /**
   * Get resolution statistics for monitoring
   */
  public getResolutionStats() {
    return {
      cacheSize: this.cache.size,
      activeResolutions: this.resolutionPromises.size,
      resolutionKeys: Array.from(this.resolutionPromises.keys()),
    };
  }

  /**
   * The instance was built from state that is gone ( restoreState() or abandonPending() ran meanwhile ), so it is disposed
   * instead of cached, and whoever awaits it gets the rejection.
   */
  private async discardLate(keyName: string, instance: unknown): Promise<never> {
    let disposeError: Error | undefined;
    if (instance instanceof Service) {
      try {
        await instance.dispose();
      } catch (err) {
        disposeError = err as Error;
      }
    }
    throw new ResolveException(`${keyName} finished resolving after the container was restored; it was disposed instead of cached`, disposeError);
  }

  /**
   * Waits until no resolution started in this container is in flight, including ones started while waiting.
   * Gives up after `maxPasses` rounds of waiting and returns false when resolutions are still in flight.
   */
  public async settle(maxPasses = Infinity): Promise<boolean> {
    for (let pass = 0; ; pass++) {
      const checked = [...this.pendingChecked.values()].flat().map((p) => p.promise);
      const pending = [...this.resolutionPromises.values(), ...checked];
      if (pending.length === 0) {
        return true;
      }
      if (pass >= maxPasses) {
        return false;
      }

      await Promise.allSettled(pending);
    }
  }

  /** The type names of the resolutions in flight. */
  public pendingKeys(): string[] {
    return [...new Set([...this.resolutionPromises.keys(), ...this.pendingChecked.keys()])];
  }

  /** Stops tracking the resolutions in flight: each one is disposed when it finishes, never cached. */
  public abandonPending(): void {
    this.epoch++;
    this.resolutionPromises.clear();
    this.creatingKeys.clear();
    this.pendingChecked.clear();
  }

  /** Synchronous, unlike settle(): true while a resolution started in this container is in flight. */
  public hasPending(): boolean {
    return this.resolutionPromises.size > 0 || this.pendingChecked.size > 0;
  }

  public snapshotState(): Map<string, unknown[]> {
    return new Map([...this.cache].map(([key, list]) => [key, [...list]]));
  }

  /**
   * The instances cached now that `state` does not hold, in reverse order of their cache keys. That is latest resolved first,
   * except for an instance appended to a key that already existed.
   */
  public droppedSince(state: ReadonlyMap<string, unknown[]>): unknown[] {
    const kept = new Set<unknown>([...state.values()].flat());
    const dropped = new Set<unknown>();
    for (const { value } of this) {
      if (!kept.has(value)) {
        dropped.add(value);
      }
    }

    return [...dropped].reverse();
  }

  /** Resolutions still in flight are abandoned ( see abandonPending() ). */
  public restoreState(state: ReadonlyMap<string, unknown[]>): void {
    this.cache = new Map([...state].map(([key, list]) => [key, [...list]]));
    this.abandonPending();
  }

  public clear() {
    this.cache.clear();
    this.resolutionPromises.clear();
    this.creatingKeys.clear();
    this.pendingChecked.clear();
    this.addSelf();
  }
}
