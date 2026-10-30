import { BindException } from './exceptions.js';
import { ResolveType } from './enums.js';
import { isFactory, isConstructor, getTypeName } from './helpers.js';
import { IBind, IContainer, IInjectDescriptor, RegisterOptions, ResolvableObject } from './interfaces.js';
import { Class, Factory } from './types.js';
import { AddDependency } from './decorators.js';
import { Token } from './token.js';

export class Binder<T> implements IBind {
  private isFactory: boolean;
  private isConstructor: boolean;

  constructor(private implementation: Class<T> | Factory<T> | ResolvableObject, private container: IContainer) {
    this.isFactory = isFactory(implementation);
    this.isConstructor = isConstructor(implementation);
  }

  as<T>(type: string | Class<T>, options?: RegisterOptions): this {
    this.container.Registry.register(type, this.implementation, options);

    const iType = getTypeName(this.implementation);
    const tType = getTypeName(type);
    this.container.emit(`di.registered.${iType}`, this.implementation);
    this.container.emit(`di.registered.${tType}`, this.implementation);

    return this;
  }

  asToken<V>(token: Token<V>, options?: RegisterOptions): this {
    return this.as(token.key, options);
  }

  /**
   * Binds a plain value under `type`. Values are registrations: clearCache() keeps them, clearRegistry() drops them.
   *
   * @param type - name of added value
   * @param override - if true, replaces the values and the instances already held under `type` in this container
   */
  asValue(type: string, override = false): this {
    if (override) {
      this.container.Cache.remove(type);
    }
    this.container.Registry.registerValue(type, this.implementation, override);
    this.container.emit(`di.registered.${getTypeName(type)}`, this.implementation);
    return this;
  }

  /**
   * Adds a plain value to a map stored under `type`, for o(1) access by `key`
   * ( eg. value converters looked up by the type they convert ).
   *
   * @param type - name of added value
   * @param key - hashmap key
   */
  asMapValue(type: string, key: string) {
    let map = this.container.Registry.getValues(type)?.[0] as Map<string, unknown> | undefined;
    if (!map) {
      map = new Map<string, unknown>();
      this.container.Registry.registerValue(type, map);
    }

    map.set(key, this.implementation);

    this.container.emit(`di.registered.${getTypeName(this.implementation)}`, this.implementation);
    this.container.emit(`di.registered.${getTypeName(type)}`, this.implementation);

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

    const iType = getTypeName(this.implementation);
    this.container.emit(`di.registered.${iType}`, this.implementation);
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
      AddDependency((descriptor: IInjectDescriptor<unknown>) => {
        descriptor.resolver = ResolveType.Singleton;
      })(this.implementation as Class<unknown>);
    }
    return this;
  }
}
