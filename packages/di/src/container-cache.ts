import { TypedArray } from './array';
import { getTypeName } from './helpers';
import { IContainer } from './interfaces';
import { Class } from './types';

export class ContainerCache {
  private cache: Map<string, any[]>;

  constructor(private container: IContainer) {
    this.cache = new Map<string, any[]>();

    // add to cache container
    // so we can inject container if needed
    this.add(container, container);
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

  public clear() {
    this.cache.clear();
    this.add(this.container, this.container);
  }
}
