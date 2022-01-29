import { getTypeName } from './helpers';
import { IContainer } from './interfaces';
import { Class } from './types';

export class ContainerCache {
  private cache: Map<string, any[]>;

  constructor(private container: IContainer) {
    this.cache = new Map<string, any[]>();
  }

  public add(key: string | Class<any>, instance: any) {
    const tName = getTypeName(key);

    if (this.has(key)) {
      this.cache.get(tName).push(instance);
    } else {
      this.cache.set(tName, [instance]);
    }
  }

  public has(key: string | Class<any>, parent?: boolean): boolean {
    if (this.cache.has(getTypeName(key))) {
      return true;
    }

    if (parent && this.container.Parent) {
      return this.container.Parent.Cache.has(key, parent);
    }

    return false;
  }

  public get(key: string | Class<any>, parent?: boolean): any {
    const tName = getTypeName(key);

    if (this.cache.has(tName)) {
      return this.cache.get(tName);
    }

    if (parent && this.container.Parent) {
      return this.container.Parent.Cache.get(key);
    }

    return undefined;
  }

  public clear() {
    this.cache.clear();
  }
}
