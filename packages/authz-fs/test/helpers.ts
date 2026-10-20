import { Configuration } from '@spinajs/configuration';
import type { ConfigurationSource, IConfigLike } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

/** A Configuration over a plain object, without files or sources. */
export class FakeConfiguration extends Configuration {
  private data: Record<string, unknown> = {};

  get RootConfig(): IConfigLike {
    return this.data as IConfigLike;
  }

  get<T>(path: string[] | string, defaultValue?: T): T {
    let cur: unknown = this.data;
    for (const segment of typeof path === 'string' ? path.split('.') : path) {
      if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, segment)) return defaultValue as T;
      cur = (cur as Record<string, unknown>)[segment];
    }
    return cur as T;
  }

  set(path: string[] | string, value: unknown): void {
    const segments = typeof path === 'string' ? path.split('.') : path;
    let cur = this.data;
    for (const segment of segments.slice(0, -1)) {
      if (cur[segment] === null || typeof cur[segment] !== 'object') cur[segment] = {};
      cur = cur[segment] as Record<string, unknown>;
    }
    cur[segments[segments.length - 1]] = value;
  }

  merge(path: string[] | string, value: unknown): void {
    this.set(path, value);
  }

  async mergeSource(_source: new () => ConfigurationSource): Promise<void> {}

  async load(): Promise<void> {}

  protected onLoad(): unknown {
    return undefined;
  }
}

/** A child of the root holding a FakeConfiguration with `authz.fs` set to `fs`. */
export async function configuredChild(fs: unknown): Promise<IContainer> {
  const child = DI.child();
  child.register(FakeConfiguration).as(Configuration);
  const configuration = (await child.resolve(Configuration)) as Configuration;
  if (fs !== undefined) configuration.set(['authz', 'fs'], fs);
  return child;
}
