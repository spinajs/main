import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { TypedArray } from './array';
import { getTypeName, isConstructor, isFactory } from './helpers';
import { IContainer } from './interfaces';
import { Class, Factory } from './types';

export class Registry {
  protected registry: Map<string, any[]> = new Map<string, any[]>();

  constructor(protected container: IContainer) {
    this.initialize();
  }

  public clear() {
    this.registry.clear();
    this.initialize();
  }

  public register(name: string | Class<any> | TypedArray<any>, type: any) {
    if (!isConstructor(type) && !isFactory(type)) {
      throw new InvalidOperation('cannot register type if its not an class or factory function');
    } else {
      const tname = getTypeName(name);
      if (!this.hasRegisteredType(name, type)) {
        const value = this.registry.get(tname);

        if (value) {
          value.push(type);
        } else {
          this.registry.set(tname, [type]);
        }
      }
    }
  }

  public hasRegisteredType(source: Class<any> | string | TypedArray<any>, type: Class<any> | string | TypedArray<any>, parent?: boolean) {
    const sourceName = getTypeName(source);
    const targetName = getTypeName(type);
    if (this.registry.has(sourceName)) {
      return this.registry.get(sourceName).find((s) => s.name === targetName) !== undefined;
    } else if (parent && this.container.Parent) {
      return this.container.Parent.hasRegisteredType(source, type, parent);
    }
    return false;
  }

  public getTypes<T>(service: string | Class<T> | TypedArray<T>, parent = true): Array<Class<unknown> | Factory<unknown>> {
    if (!service) {
      throw new InvalidArgument('argument "service" cannot be null or empty');
    }

    const name = getTypeName(service);

    if (this.registry.has(name)) {
      return this.registry.get(name);
    }

    if (this.container.Parent && parent) {
      return this.container.Parent.getRegisteredTypes(service, parent);
    }

    return null;
  }

  public hasRegistered<T>(service: TypedArray<T> | Class<T> | string, parent = true): boolean {
    if (!this.registry.has(getTypeName(service)) && parent && this.container.Parent) {
      return this.container.Parent.hasRegistered(service, parent);
    }

    return false;
  }

  protected initialize() {
    // allows container instance to be resolved
    this.register('Container', this.container);
  }
}
