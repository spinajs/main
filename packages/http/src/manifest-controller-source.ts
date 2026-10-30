import { Autoinject, Class, ClassInfo, Container, IContainer, Injectable } from '@spinajs/di';
import { effectiveManifestOf } from '@spinajs/configuration';
import { inScanOrder, listFromManifest } from '@spinajs/reflection';
import { BaseController } from './base-controller.js';
import { ControllerSource } from './controller-sources.js';
import { CONTROLLED_DESCRIPTOR_SYMBOL } from './decorators.js';

const isController = (prototype: object): boolean => prototype instanceof BaseController || Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, prototype) !== undefined;

/**
 * Controllers listed in `app.manifest.json`. Empty when the effective manifest mode is `off`, or `prefer` without a
 * registered manifest; `require` without one throws.
 *
 * Listed in the directory scan's order, so routes register the same way in both modes. The manifest names every
 * controller of the app and its packages, whatever `system.dirs.controllers` says.
 */
@Injectable(ControllerSource)
export class ManifestControllerSource extends ControllerSource {
  @Autoinject(Container)
  protected Container!: IContainer;

  public async getControllers(): Promise<Array<ClassInfo<BaseController>>> {
    const effective = effectiveManifestOf(this.Container);
    if (!effective || effective.settings.mode === 'off') {
      return [];
    }

    const listed = (await listFromManifest(this.Container, 'controllers', effective.settings.mode)) as Array<ClassInfo<BaseController>> | undefined;
    if (!listed) {
      return [];
    }

    return inScanOrder(listed)
      .filter((ci) => isController((ci.type as Class<BaseController>).prototype as object))
      .map((ci) => Object.assign(new ClassInfo<BaseController>(), { file: ci.file, name: ci.name, type: ci.type }));
  }
}
