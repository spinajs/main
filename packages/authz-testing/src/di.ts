import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';

export type OwnedType = Class<unknown> | string;

/**
 * Drops the cached instances of the listed types from `container` (default: root) and nothing else.
 * Prefer this over clearCache(): a blanket clear also drops singletons other suites still hold.
 */
export function uncacheOwned(types: readonly OwnedType[], container: IContainer = DI.RootContainer): void {
  for (const t of types) container.uncache(t);
}

/** A class registered as itself, or [implementation, token]. */
export type ChildRegistration = Class<unknown> | readonly [Class<unknown>, OwnedType];

export interface ScopedContainerOptions<T> {
  /** Default: the root container. */
  readonly parent?: IContainer;
  /** Registered in the fresh child, which therefore owns (creates and caches) them. */
  readonly register?: readonly ChildRegistration[] | ((child: IContainer) => void);
  readonly resolve: (child: IContainer) => T | Promise<T>;
  /** Parent-owned types the test causes to be created; uncached from the parent on dispose. */
  readonly uncache?: readonly OwnedType[];
}

export interface ScopedContainer<T> {
  readonly container: IContainer;
  readonly resolved: T;
  /** Idempotent: disposes child-owned instances and the child, then uncaches `uncache` from the parent. */
  dispose(): Promise<void>;
}

/**
 * Since DI-2 (F2 report, change A) a parent-registered singleton first resolved through a child is
 * created in the parent and survives child.dispose(): a child container never yields fresh
 * singletons of parent-registered types. Register what must be fresh in the child (`register`), and
 * list the parent-owned types the test touches in `uncache`.
 */
export async function scopedContainer<T>(opts: ScopedContainerOptions<T>): Promise<ScopedContainer<T>> {
  const parent = opts.parent ?? DI.RootContainer;
  const child = parent.child();

  if (typeof opts.register === 'function') {
    opts.register(child);
  } else {
    for (const r of opts.register ?? []) {
      if (Array.isArray(r)) child.register(r[0]).as(r[1]);
      else child.register(r as Class<unknown>).asSelf();
    }
  }

  let disposed: Promise<void> | undefined;
  const dispose = () => (disposed ??= disposeScope(child, parent, opts.uncache ?? []));

  try {
    const resolved = await opts.resolve(child);
    return { container: child, resolved, dispose };
  } catch (e) {
    await dispose();
    throw e;
  }
}

async function disposeScope(child: IContainer, parent: IContainer, uncache: readonly OwnedType[]): Promise<void> {
  await child.dispose({ plainOwners: true });
  uncacheOwned(uncache, parent);
}
