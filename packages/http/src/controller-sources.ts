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
    return (await this.Controllers) ?? [];
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
