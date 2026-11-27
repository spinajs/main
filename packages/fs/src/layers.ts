import { DI, getTypeName, isConstructor, isPromise } from '@spinajs/di';
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
  // Array.ofType never reads values, and hasRegistered does not see them.
  for (let c: IContainer | undefined = container; c; c = c.Parent) {
    if (c.Registry.hasValue(getTypeName(FsProviderLayer))) {
      throw new InvalidOperation('An FsProviderLayer registered with asValue() cannot run: register the layer class as a singleton (@Injectable(FsProviderLayer))');
    }
  }
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

/**
 * The layers of every container from the root down to `container`. A container that registers layers of its own hides
 * its ancestors' list from `Array.ofType`, so each such ancestor's list is resolved where it was registered.
 */
function layersOf(container: IContainer): FsProviderLayer[] {
  const lists = [layersIn(container)];
  let owner: IContainer | undefined = container;
  while (owner && !owner.Registry.ownsRegistration(FsProviderLayer)) owner = owner.Parent;
  for (let hidden = owner?.Parent; hidden; hidden = hidden.Parent) {
    if (hidden.Registry.ownsRegistration(FsProviderLayer)) lists.unshift(layersIn(hidden));
  }
  // A class registered at several levels runs once, at its place in the farthest list, as the nearest container's instance.
  const byClass = new Map<unknown, FsProviderLayer>();
  for (const layer of lists.flat()) byClass.set(layer.constructor, layer);
  return [...byClass.values()];
}

// Array.ofType leaves factories and @NewInstance() classes out of its result: a layer skipped that way would hand out the published provider.
function layersIn(container: IContainer): FsProviderLayer[] {
  const registered = (container.getRegisteredTypes(Array.ofType(FsProviderLayer)) ?? []).map((type) => replacementsOf(type, container));
  const layers: FsProviderLayer[] | Promise<FsProviderLayer[]> = registered.every((chain) => chain.every(isConstructor)) ? container.resolve(Array.ofType(FsProviderLayer)) : [];
  if (isPromise(layers)) {
    // The error below is what the caller gets; the resolve left running must not end as an unhandled rejection.
    layers.catch(() => undefined);
    throw new InvalidOperation(
      'An FsProviderLayer resolves asynchronously (it or a dependency is an AsyncService not resolved yet), and a layer must be synchronous: resolve the layers before the first lookup, eg. await DI.resolve(Array.ofType(FsProviderLayer)) at boot',
    );
  }
  // `instanceof` would let a skipped @NewInstance() class through when a singleton subclass of it is registered too.
  const skipped = registered.filter((chain) => !layers.some((layer) => chain.some((type) => type === layer.constructor)));
  if (skipped.length > 0) {
    throw new InvalidOperation(
      `FsProviderLayer ${skipped.map((chain) => getTypeName(chain[0])).join(', ')} cannot run: DI does not hand it out as a singleton instance (a factory, an instance or a @NewInstance() class, also as a replacement); register the layer class as a singleton (@Injectable(FsProviderLayer))`,
    );
  }
  return layers;
}
