import { BindException } from './exceptions.js';
import { ResolveType } from './enums.js';
import { isFactory, isConstructor } from './helpers.js';
import { IBind, IContainer, IInjectDescriptor, ResolvableObject } from './interfaces.js';
import { Class, Factory } from './types.js';
import { DI } from './index.js';

export class Binder<T> implements IBind {
  private isFactory: boolean;
  private isConstructor: boolean;

  constructor(private implementation: Class<T> | Factory<T> | ResolvableObject, private container: IContainer) {
    this.isFactory = isFactory(implementation);
    this.isConstructor = isConstructor(implementation);
  }

  as<T>(type: string | Class<T>): this {
    this.container.Registry.register(type, this.implementation);
    return this;
  }

  /**
   * Add plain value to container. If value exists, it overrides content in  container cache
   *
   * @param type - name of added value
   * @param override - if true, any value registered before is overriden by new one
   * @returns
   */
  asValue(type: string, override = false): this {
    if (override) {
      if (this.container.Cache.has(type)) {
        this.container.Cache.remove(type);
      }
    }
    this.container.Cache.add(type, this.implementation);
    return this;
  }

  /**
   *
   * Add plain value to container, value is stored in hashmap for quick access
   * eg. we have multiple value converters and we wanc o(1) access, instead searching for
   * converter for specific type
   *
   * @param type - name of added value
   * @param key - hashmap key
   */
  asMapValue(type: string, key: string) {
    let map = null;
    if (this.container.Cache.has(type)) {
      map = this.container.Cache.get(type)[0] as Map<any, any>;
    } else {
      map = new Map<string, any>();
      this.container.Cache.add(type, map);
    }

    map.set(key, this.implementation);

    return this;
  }

  /**
   * Register type as itself. Usefull when we also want to register type as self instead of base class
   * so we can retrieve just this specific instance.
   * @returns this
   */
  asSelf(): this {
    if (!this.isConstructor || this.isFactory) {
      throw new BindException('cannot register as self non class');
    }

    // we can safly cast to any, we checked params earlier
    this.container.Registry.register(this.implementation as any, this.implementation);
    return this;
  }

  /**
   * Mark type as SingleInstance resolve strategy.
   * @returns this
   */
  singleInstance(): this {
    if (this.isFactory || !this.isConstructor) {
      throw new BindException('Cannot bind factory function as singleton.');
    } else {
      const descriptor: IInjectDescriptor<unknown> = DI.RootContainer.extractDescriptor(this.implementation as Class<unknown>);
      descriptor.resolver = ResolveType.Singleton;
    }
    return this;
  }
}
