import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { TypedArray } from './array.js';
import { getTypeName, isConstructor, isFactory, isObject } from './helpers.js';
import { IChainRegistration, IContainer } from './interfaces.js';
import { Class, Factory } from './types.js';

export class Registry {
  protected registry: Map<string, any[]> = new Map<string, any[]>();

  /**
   * Keys created only by resolving an unregistered type ( the container records it under
   * its own name ). They do not make the container the owner of the key.
   */
  protected implicitKeys = new Set<string>();

  constructor(protected container: IContainer) { }

  public clear() {
    this.registry.clear();
    this.implicitKeys.clear();
  }

  /**
   * True when this registry ( not an ancestor ) holds an entry for `service` that was
   * registered on purpose, not just recorded by a resolve.
   */
  public ownsRegistration<T>(service: TypedArray<T> | Class<T> | string): boolean {
    const name = getTypeName(service);
    return this.registry.has(name) && !this.implicitKeys.has(name);
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

  public register(name: string | Class<any> | TypedArray<any>, type: any, implicit = false) {
    if (!isConstructor(type) && !isFactory(type) && !isObject(type)) {
      throw new InvalidOperation('cannot register type if its not an class or factory function');
    } else {
      const tname = getTypeName(name);
      const value = this.registry.get(tname);

      if (!implicit) {
        this.implicitKeys.delete(tname);
      } else if (!value) {
        this.implicitKeys.add(tname);
      }

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
      return this.registry.get(sourceName)!.find((s) => s.name === targetName) !== undefined;
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
      return this.registry.get(name)!;
    }

    if (this.container.Parent && parent) {
      return this.container.Parent.getRegisteredTypes(service, parent);
    }

    return null as any;
  }

  public getTypesChain<T>(service: string | Class<T> | TypedArray<T>): IChainRegistration[] {
    if (!service) {
      throw new InvalidArgument('argument "service" cannot be null or empty');
    }

    const lineage: IContainer[] = [];
    for (let c: IContainer | undefined = this.container; c; c = c.Parent) {
      lineage.unshift(c);
    }

    // A self record left by resolving the key before anything was registered must not
    // join a real registration made later.
    const anyOwner = lineage.some((c) => c.Registry.ownsRegistration(service));

    const chain: IChainRegistration[] = [];
    for (const container of lineage) {
      if (anyOwner && !container.Registry.ownsRegistration(service)) {
        continue;
      }

      for (const type of container.Registry.getTypes(service, false) ?? []) {
        const name = isFactory(type) ? null : getTypeName(type);
        const replaced = name === null ? -1 : chain.findIndex((e) => !isFactory(e.type) && getTypeName(e.type) === name);

        if (replaced === -1) {
          chain.push({ type, container });
        } else {
          chain[replaced] = { type, container };
        }
      }
    }

    return chain;
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
