import { pathToFileURL } from 'node:url';
import { manifestFileFor, ManifestMissing } from './runtime.js';
import type { Manifest, RuntimeTypeRef } from './types.js';

interface Resolved {
  pending: Map<string, Promise<unknown>>;
  settled: Map<string, unknown>;
}

const RESOLVED = new WeakMap<Manifest, Resolved>();

const keyOf = (ref: RuntimeTypeRef): string => `${ref.package}\0${ref.file}\0${ref.export}`;

function resolvedOf(manifest: Manifest): Resolved {
  let resolved = RESOLVED.get(manifest);
  if (!resolved) {
    resolved = { pending: new Map(), settled: new Map() };
    RESOLVED.set(manifest, resolved);
  }
  return resolved;
}

async function load(ref: RuntimeTypeRef, manifest: Manifest, cwd: string): Promise<unknown> {
  if (ref.package === 'global') {
    const value = (globalThis as Record<string, unknown>)[ref.export];
    if (value === undefined) {
      throw new ManifestMissing(`runtime type ${ref.export} is not a global`);
    }
    return value;
  }

  const file = manifestFileFor({ source: { package: ref.package, file: ref.file, line: 1, col: 1 } }, manifest, cwd);
  const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  if (!(ref.export in module)) {
    throw new ManifestMissing(`runtime type of ${ref.package} (${ref.file}): ${file} does not export ${ref.export}; run spinajs build`);
  }
  return module[ref.export];
}

/**
 * The value a `TypeRef.ref` names: a global constructor, or an export of a file the manifest lists, imported through
 * `manifestFileFor` (root containment). Memoised per manifest; a failed import is retried on the next call.
 */
export function resolveTypeRef(ref: RuntimeTypeRef, manifest: Manifest, cwd = process.cwd()): Promise<unknown> {
  const { pending, settled } = resolvedOf(manifest);
  const key = keyOf(ref);
  if (settled.has(key)) return Promise.resolve(settled.get(key));

  let loading = pending.get(key);
  if (!loading) {
    loading = load(ref, manifest, cwd).then(
      (value) => {
        settled.set(key, value);
        pending.delete(key);
        return value;
      },
      (err: unknown) => {
        pending.delete(key);
        throw err;
      },
    );
    pending.set(key, loading);
  }
  return loading;
}

/** What `resolveTypeRef` already resolved for `ref` with this manifest; `undefined` before that. */
export function resolvedTypeRef(ref: RuntimeTypeRef, manifest: Manifest): unknown {
  return RESOLVED.get(manifest)?.settled.get(keyOf(ref));
}
