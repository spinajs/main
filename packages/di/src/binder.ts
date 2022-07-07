import { BindException } from './exceptions';
import { DI_DESCRIPTION_SYMBOL } from './decorators';
import { ResolveType } from './enums';
import { isFactory } from './helpers';
import { IBind, IContainer, IInjectDescriptor, ResolvableObject } from './interfaces';
import { Class, Factory } from './types';
import { isConstructor } from '.';

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
   * @returns
   */
  asValue(type: string, clearPrevious = false): this {
    if (clearPrevious) {
      if (this.container.Cache.has(type)) {
        this.container.Cache.remove(type);
      }
    }
    this.container.Cache.add(type, this.implementation);
    return this;
  }

  asSelf(): this {
    if (!this.isConstructor || this.isFactory) {
      throw new BindException('cannot register as self non class');
    }

    // we can safly cast to any, we checked params earlier
    this.container.Registry.register(this.implementation as any, this.implementation);
    return this;
  }
  singleInstance(): this {
    const descriptor: IInjectDescriptor<unknown> = {
      inject: [],
      resolver: ResolveType.Singleton,
    };

    if (this.isFactory || !this.isConstructor) {
      throw new BindException('Cannot bind factory function as singleton.');
    } else {
      (this.implementation as any)[`${DI_DESCRIPTION_SYMBOL}`] = descriptor;
    }
    return this;
  }
}
