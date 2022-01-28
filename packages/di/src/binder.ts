import { BindException } from './exceptions';
import { DI_DESCRIPTION_SYMBOL } from './decorators';
import { ResolveType } from './enums';
import { isFactory } from './helpers';
import { IBind, IContainer, IInjectDescriptor } from './interfaces';
import { Class, Factory } from './types';

export class Binder<T> implements IBind {
  constructor(private implementation: Class<T> | Factory<T>, private container: IContainer) {}

  as<T>(type: string | Class<T>): this {
    const tname = typeof type === 'string' ? type : type.name;
    if (!this.container.hasRegisteredType(tname, this.implementation)) {
      const value = this.container.Registry.get(tname);

      if (value) {
        value.push(this.implementation);
      } else {
        this.container.Registry.set(tname, [this.implementation]);
      }
    }

    return this;
  }
  asSelf(): this {
    this.container.Registry.set(this.implementation.name, [this.implementation]);
    return this;
  }
  singleInstance(): this {
    const descriptor: IInjectDescriptor<unknown> = {
      inject: [],
      resolver: ResolveType.Singleton,
    };

    if (isFactory(this.implementation)) {
      throw new BindException('Cannot bind factory function as singleton.');
    } else {
      (this.implementation as any)[`${DI_DESCRIPTION_SYMBOL}`] = descriptor;
    }
    return this;
  }
}
