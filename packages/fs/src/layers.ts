import { DI, isConstructor } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import type { fs } from './interfaces.js';

/**
 * Hands out another provider in place of the one looked up by name (`getFs`, `provider()`, `@FileSystem()`), such as a
 * tenant's view of a shared provider. Called on every lookup, so it caches what it builds; it returns `provider` itself
 * to leave it alone. Layers apply in registration order. `publishedFs()` still answers the raw provider.
 */
export abstract class FsProviderLayer {
  public abstract wrap(provider: fs): fs;
}

/** `provider` as the registered layers hand it out; `provider` itself when none is registered. */
export function layeredFs(provider: fs, container: IContainer = DI.RootContainer): fs {
  if (!container.hasRegistered(FsProviderLayer)) return provider;
  let layered = provider;
  for (const layer of layersOf(container)) layered = layer.wrap(layered);
  return layered;
}

// Array.ofType leaves factories and @NewInstance() classes out of its result: a layer skipped that way would hand out the published provider.
function layersOf(container: IContainer): FsProviderLayer[] {
  const registered = container.getRegisteredTypes(Array.ofType(FsProviderLayer)) ?? [];
  const layers: FsProviderLayer[] = registered.every(isConstructor) ? container.resolve(Array.ofType(FsProviderLayer)) : [];
  if (!registered.every((type) => layers.some((layer) => layer.constructor === type))) {
    throw new InvalidOperation('An FsProviderLayer registered as a factory, an instance or a @NewInstance() class cannot run: register the layer class as a singleton (@Injectable(FsProviderLayer))');
  }
  return layers;
}
