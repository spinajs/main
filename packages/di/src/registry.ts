import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { TypedArray } from './array.js';
import { getTypeName, isConstructor, isFactory, isObject } from './helpers.js';
import { IContainer } from './interfaces.js';
import { Class, Factory } from './types.js';

export class Registry {
  protected registry: Map<string, any[]> = new Map<string, any[]>();

  constructor(protected container: IContainer) { }

  public clear() {
    this.registry.clear();
  }

  public unregister(type: any) {
    const tname = getTypeName(type);

    this.registry.forEach((value) => {
      const index = value.findIndex((x) => getTypeName(x) === tname);
      if (index !== -1) {
        value.splice(index, 1);
      }
    });
  }

  public register(name: string | Class<any> | TypedArray<any>, type: any) {
    if (!isConstructor(type) && !isFactory(type) && !isObject(type)) {
      throw new InvalidOperation('cannot register type if its not an class or factory function');
    } else {
      const tname = getTypeName(name);
      const value = this.registry.get(tname);
      if (value) {
        // factory functions, we always add to registry
        // its impossible to check for duplicates
        // all would return 'Function' type
        if (isFactory(type)) {
          value.push(type);
        } else if (!value.find((v) => getTypeName(v) === getTypeName(type))) {
          value.push(type);
        }
      } else {
        this.registry.set(tname, [type]);
      }
    }
  }

  public hasRegisteredType(source: Class<any> | string | TypedArray<any>, type: Class<any> | string | TypedArray<any> | object, parent?: boolean) {
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

    const serviceName = getTypeName(service);
    let name = getTypeName(service);
    let types: Array<Class<unknown> | Factory<unknown>> | null = null;

    while (this.registry.has(name)) {
      types = this.registry.get(name);
      if (types && types.length > 0) {
        
        name = getTypeName(types[types.length - 1]);
        
        if (name === serviceName) {
          break;
        }

      } else {
        break;
      }
    }

    if (types) {
      return types;
    }

    if (this.container.Parent && parent) {
      return this.container.Parent.getRegisteredTypes(service, parent);
    }

    return null;
  }

  public hasRegistered<T>(service: TypedArray<T> | Class<T> | string, parent = true): boolean {
    if (this.registry.has(getTypeName(service))) {
      return true;
    } else if (parent && this.container.Parent) {
      return this.container.Parent.hasRegistered(service, parent);
    }

    return false;
  }
}
