import { DI, getTypeName, isConstructor } from '@spinajs/di';
import type { Class, Factory, IContainer } from '@spinajs/di';
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

type Registered = Class<unknown> | Factory<unknown>;

/** `type` and every type it is replaced by (`register(Sub).as(type)`), as DI follows them to the class it creates. */
function replacementsOf(type: Registered, container: IContainer): Registered[] {
  const chain = [type];
  let last = type;
  while (isConstructor(last)) {
    const next = container.getRegisteredTypes(last)?.at(-1);
    if (next === undefined || chain.includes(next)) break;
    chain.push(next);
    last = next;
  }
  return chain;
}

// Array.ofType leaves factories and @NewInstance() classes out of its result: a layer skipped that way would hand out the published provider.
function layersOf(container: IContainer): FsProviderLayer[] {
  const registered = (container.getRegisteredTypes(Array.ofType(FsProviderLayer)) ?? []).map((type) => replacementsOf(type, container));
  const layers: FsProviderLayer[] = registered.every((chain) => chain.every(isConstructor)) ? container.resolve(Array.ofType(FsProviderLayer)) : [];
  // `instanceof` would let a skipped @NewInstance() class through when a singleton subclass of it is registered too.
  const skipped = registered.filter((chain) => !layers.some((layer) => chain.some((type) => type === layer.constructor)));
  if (skipped.length > 0) {
    throw new InvalidOperation(
      `FsProviderLayer ${skipped.map((chain) => getTypeName(chain[0])).join(', ')} cannot run: DI does not hand it out as a singleton instance (a factory, an instance or a @NewInstance() class, also as a replacement); register the layer class as a singleton (@Injectable(FsProviderLayer))`,
    );
  }
  return layers;
}
