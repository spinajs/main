import { Autoinject, ClassInfo, Container, IContainer, Injectable, Singleton } from '@spinajs/di';
import type { BaseController } from './base-controller.js';
import { ControllerMetadataProvider } from './controller-metadata.js';
import type { IControllerDocumentation, IPolicyDoc } from './controller-documentation.js';
import { isOnDiskSource } from './cache-helpers.js';
import type { DefaultControllerCache } from './cache.js';

/**
 * Parameter names and JSDoc parsed from the controller's `.d.ts` by the TypeScript compiler, cached under
 * `__fs_controller_cache__`. `./cache.js` is imported on the first controller with a source file, and `typescript` only
 * on a cache miss, so neither a process that never reaches this provider nor one with a complete cache loads it.
 */
@Singleton()
@Injectable(ControllerMetadataProvider)
export class CacheControllerMetadata extends ControllerMetadataProvider {
  public readonly Priority = 100;

  @Autoinject(Container)
  protected Container!: IContainer;

  protected cache?: Promise<DefaultControllerCache>;

  protected parametersByController = new Map<string, Promise<Record<string, string[]>>>();

  public supports(): boolean {
    return true;
  }

  /** A failed load is not kept, so a later controller tries again. */
  protected getCacheService(): Promise<DefaultControllerCache> {
    this.cache ??= import('./cache.js')
      .then(({ DefaultControllerCache }) => this.Container.resolve(DefaultControllerCache))
      .catch((err: unknown) => {
        this.cache = undefined;
        throw err;
      });
    return this.cache;
  }

  /** A controller without a source file ( `<di>`, `<dynamic>` ) has nothing to parse: the loader reads names off the function. */
  public async parameters(controller: ClassInfo<BaseController>, method: string): Promise<string[]> {
    if (!isOnDiskSource(controller.file)) {
      return [];
    }

    const key = `${controller.file}#${controller.name}`;
    let all = this.parametersByController.get(key);
    if (!all) {
      all = this.getCacheService().then((cache) => cache.getCache(controller));
      all.catch(() => this.parametersByController.delete(key));
      this.parametersByController.set(key, all);
    }
    return (await all)[method] ?? [];
  }

  public async documentation(controller: ClassInfo<BaseController>): Promise<IControllerDocumentation> {
    if (!isOnDiskSource(controller.file)) {
      return { className: controller.name, methods: {} };
    }
    return (await this.getCacheService()).getDocumentation(controller);
  }

  /** Policy docs come from the policy classes' sources; only this provider reads sources. */
  public async policyDocumentation(controller: ClassInfo<BaseController>, names: string[]): Promise<Record<string, IPolicyDoc>> {
    return (await this.getCacheService()).getPolicyDocumentation(controller, names);
  }
}
