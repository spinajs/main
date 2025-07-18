import _ from 'lodash';
import { TypedArray } from './array.js';
import { getTypeName } from './helpers.js';
import { IContainer, IInjectDescriptor, IInstanceCheck } from './interfaces.js';
import { Class } from './types.js';
import { ResolveType } from './enums.js';
import { ResolveException } from './exceptions.js';

export class ContainerCache {
  private cache: Map<string, any[]>;
  // Track ongoing resolution promises to prevent concurrent singleton creation
  private resolutionPromises: Map<string, Promise<any>> = new Map();
  // Track keys currently being created synchronously
  private creatingKeys: Set<string> = new Set();

  constructor(private container: IContainer) {
    this.cache = new Map<string, any[]>();

    // add to cache container
    // so we can inject container if needed
    this.add(container, container);
  }

  *[Symbol.iterator]() {
    for (const [key, value] of this.cache) {
      for (const v of value) {
        yield { key, value: v };
      }
    }
  }

  public remove(key: string | Class<any> | TypedArray<any>, parent?: boolean): void {
    if (this.has(key)) {
      this.cache.delete(getTypeName(key));
    } else if (parent && this.container.Parent) {
      this.container.Parent.uncache(key);
    }
  }

  public add(key: string | Class<any> | object, instance: any) {
    const tName = getTypeName(key);

    if (this.has(key)) {
      if (this.cache.get(tName).indexOf(instance) === -1) {
        this.cache.get(tName).push(instance);
      }
    } else {
      this.cache.set(tName, [instance]);
    }
  }

  /**
   * Add instance to cache only if it doesn't already exist (atomic operation for singletons)
   */
  public addIfNotExists(key: string | Class<any> | object, instance: any): boolean {
    const tName = getTypeName(key);

    if (this.has(key)) {
      return false; // Already exists, don't add
    } else {
      this.cache.set(tName, [instance]);
      return true; // Successfully added
    }
  }

  public has(key: string | Class<any> | object | TypedArray<any>, parent?: boolean): boolean {

    if (this.cache.has(getTypeName(key))) {
      return true;
    }

    if (parent && this.container.Parent) {
      return this.container.Parent.Cache.has(key, parent);
    }

    return false;
  }

  public get(key: string | Class<any> | TypedArray<any>, parent?: boolean): any {
    const tName = getTypeName(key);

    if (this.cache.has(tName)) {
      return this.cache.get(tName);
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
    options?: unknown[]
  ): Promise<T> | T {
    const keyName = getTypeName(targetType);
    const sourceTypeKey = getTypeName(sourceType);

    // Fast path: return cached instance if it exists
    if (this.has(targetType, descriptor.resolver === ResolveType.PerChildContainer ? false : true)) {
      const cached = this.get(targetType, descriptor.resolver === ResolveType.PerChildContainer ? false : true);

      if (descriptor.resolver === ResolveType.PerInstanceCheck) {

        if (cached) {
          const found = cached.find((x: unknown) => {
            if (!(x as IInstanceCheck).__checkInstance__) {
              // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
              throw new ResolveException(`service ${x.constructor.name} is marked as PerInstanceCheck resolver, but no __checkInstance__ function is provided`);
            }
            return (x as IInstanceCheck).__checkInstance__(options);
          });
          if (found) {
            return found;
          } else {
            return factory();
          }
        }
      }

      return Array.isArray(cached) ? cached[0] : cached;
    }

    // For non-singletons, always create new instance
    if (!isSingleton) {
      return factory();
    }

    // Check if creation is already in progress (async)
    if (this.resolutionPromises.has(keyName)) {
      return this.resolutionPromises.get(keyName);
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
      if (sourceType instanceof TypedArray) {
        // If sourceType is a TypedArray, we need to ensure we cache it correctly
        if (!this.has(sourceTypeKey)) {
          this.add(sourceTypeKey, resolvedInstance);
        } else {
          // If it already exists, we should merge the new instance into the existing array
          const existingInstances = this.get(sourceTypeKey);
          if (!existingInstances.includes(resolvedInstance)) {
            existingInstances.push(resolvedInstance);
          }
        }
      } else {
        // Cache the instance if not already cached
        if (!this.has(targetType)) {
          this.add(sourceTypeKey, resolvedInstance);
        }
      }

      // Return the cached version
      const cached = this.get(sourceTypeKey);
      return sourceType instanceof TypedArray ? cached : cached[0];
    }

    // If factory returns a Promise, handle async resolution
    if (instance instanceof Promise) {
      const creation = instance.then(resolvedInstance => {
        this.creatingKeys.delete(keyName);
        this.resolutionPromises.delete(keyName);

        return _checkCache(resolvedInstance);

      }).catch(error => {
        this.creatingKeys.delete(keyName);
        this.resolutionPromises.delete(keyName);
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

  public clear() {
    this.cache.clear();
    this.resolutionPromises.clear();
    this.creatingKeys.clear();
    this.add(this.container, this.container);
  }
}
