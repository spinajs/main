import { AsyncService, ClassInfo, Class, DI, Injectable } from '@spinajs/di';
import { ListFromFiles } from '@spinajs/reflection';
import { BaseController } from './base-controller.js';
import { CONTROLLED_DESCRIPTOR_SYMBOL } from './decorators.js';
import { IControllerDescriptor } from './interfaces.js';

/**
 * Supplies controller types to the {@link Controllers} loader.
 *
 * Sources only DISCOVER controllers (type + origin file) — they never
 * instantiate them. The loader merges all registered sources, registers the
 * types as BaseController and resolves them in a single DI pass.
 *
 * To plug in a new discovery mechanism (remote registry, plugin manifest…)
 * implement this class and decorate it with `@Injectable(ControllerSource)`.
 */
export abstract class ControllerSource extends AsyncService {
  public abstract getControllers(): Promise<Array<ClassInfo<BaseController>>>;
}

/**
 * Discovers controllers by scanning the directories configured at
 * `system.dirs.controllers`.
 */
@Injectable(ControllerSource)
export class FilesystemControllerSource extends ControllerSource {
  @ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.controllers')
  public Controllers!: Promise<Array<ClassInfo<BaseController>>>;

  public async getControllers(): Promise<Array<ClassInfo<BaseController>>> {
    const scanned = (await this.Controllers) ?? [];
    const result: Array<ClassInfo<BaseController>> = [];

    // ListFromFiles yields exactly one ClassInfo per file — whichever export
    // happens to come first. A controller file may put its DTO classes above
    // the controller (and may export more than one controller), so the first
    // export is not necessarily the controller: re-read each module and keep
    // every export that actually is one — it extends BaseController or
    // carries the route descriptor.
    for (const ci of scanned) {
      const loaded = await DI.__spinajs_require__(ci.file);

      // __spinajs_require__ unwraps a default export to the value itself;
      // treat a default-exported class as a single-entry export map.
      const exports = (typeof loaded === 'function' ? { [(loaded as Class<unknown>).name || ci.name]: loaded } : loaded) as Record<string, unknown>;

      for (const [name, value] of Object.entries(exports)) {
        if (typeof value !== 'function' || !value.prototype) {
          continue;
        }

        const isController = value.prototype instanceof BaseController || Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, value.prototype) !== undefined;
        if (!isController) {
          continue;
        }

        const info = new ClassInfo<BaseController>();
        info.file = ci.file;
        info.name = name;
        info.type = value as Class<BaseController>;
        result.push(info);
      }
    }

    return result;
  }
}

/**
 * Discovers controllers registered directly in the DI container as
 * `BaseController` BEFORE the loader resolves — e.g. by a package
 * Bootstrapper calling `DI.register(MyController).as(BaseController)`.
 *
 * The origin file comes from `Descriptor.SourceFile` captured at decoration
 * time by the route decorators; sentinel `<di>` when nothing was captured
 * (abstract base or no route decorators ran).
 */
@Injectable(ControllerSource)
export class DiRegistryControllerSource extends ControllerSource {
  public async getControllers(): Promise<Array<ClassInfo<BaseController>>> {
    const types = (DI.getRegisteredTypes(BaseController) ?? []) as Array<Class<BaseController>>;

    return types.map((type) => {
      const descriptor = Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, type.prototype) as IControllerDescriptor | undefined;

      const ci = new ClassInfo<BaseController>();
      ci.name = type.name;
      ci.type = type;
      ci.file = descriptor?.SourceFile ?? '<di>';
      return ci;
    });
  }
}
