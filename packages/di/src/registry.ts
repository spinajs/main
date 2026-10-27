import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { TypedArray } from './array.js';
import { getTypeName, isConstructor, isFactory, isObject } from './helpers.js';
import { IChainRegistration, IContainer, RegisterOptions } from './interfaces.js';
import { Class, Factory } from './types.js';

export class Registry {
  protected registry: Map<string, any[]> = new Map<string, any[]>();

  constructor(protected container: IContainer) { }

  public clear() {
    this.registry.clear();
  }

  /**
   * True when this registry ( not an ancestor ) holds an entry for `service`.
   */
  public ownsRegistration<T>(service: TypedArray<T> | Class<T> | string): boolean {
    return this.registry.has(getTypeName(service));
  }

  /**
   * Without `implementation`: removes every entry named like `type`, under any key.
   * With it: removes `implementation` itself ( by identity, so one of several arrow factories ) from the `type` key only.
   */
  public unregister(type: any, implementation?: unknown) {
    const tname = getTypeName(type);
    const byIdentity = implementation !== undefined;

    for (const [key, value] of [...this.registry]) {
      if (byIdentity && key !== tname) {
        continue;
      }

      const index = byIdentity ? value.indexOf(implementation) : value.findIndex((x) => getTypeName(x) === tname);
      if (index === -1) {
        continue;
      }

      value.splice(index, 1);
      // An empty list would still count as a registration and hide the default
      // resolution ( the type itself, or the parent's entries ).
      if (value.length === 0) {
        this.registry.delete(key);
      }
    }
  }

  public register(name: string | Class<any> | TypedArray<any>, type: any, options?: RegisterOptions) {
    if (!isConstructor(type) && !isFactory(type) && !isObject(type)) {
      throw new InvalidOperation('cannot register type if its not an class or factory function');
    }

    const tname = getTypeName(name);
    const value = this.registry.get(tname);
    if (!value) {
      this.registry.set(tname, [type]);
      return;
    }

    // factory functions are always appended: they all have the name 'Function', so duplicates cannot be told apart
    if (isFactory(type)) {
      value.push(type);
      return;
    }

    const index = value.findIndex((v) => getTypeName(v) === getTypeName(type));
    if (index === -1) {
      value.push(type);
    } else if (options?.replace) {
      value.splice(index, 1);
      value.push(type);
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

    const chain: IChainRegistration[] = [];
    for (const container of lineage) {
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
