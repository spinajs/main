import { AsyncService, ClassInfo } from '@spinajs/di';
import { Exception } from '@spinajs/exceptions';
import type { BaseController } from './base-controller.js';
import type { IControllerDocumentation } from './controller-documentation.js';

/**
 * Where the loader gets route parameter names ( argument binding ) and http-swagger gets documentation for a
 * controller. Providers are tried in `Priority` order, lower first; the first whose `supports()` is true answers.
 */
export abstract class ControllerMetadataProvider extends AsyncService {
  /** Lower runs first. Manifest 10, cache 100. */
  public abstract readonly Priority: number;

  public abstract supports(controller: ClassInfo<BaseController>): boolean;

  /** Parameter names by argument index; empty when the provider does not know the method. */
  public abstract parameters(controller: ClassInfo<BaseController>, method: string): Promise<string[]>;

  public abstract documentation(controller: ClassInfo<BaseController>): Promise<IControllerDocumentation>;
}

/** No controller metadata provider may answer for a controller. */
export class NoControllerMetadata extends Exception {}

/** The provider with the lowest `Priority` that supports `controller`. */
export function metadataProviderFor(providers: readonly ControllerMetadataProvider[], controller: ClassInfo<BaseController>): ControllerMetadataProvider | undefined {
  return [...providers].sort((a, b) => a.Priority - b.Priority).find((p) => p.supports(controller));
}
