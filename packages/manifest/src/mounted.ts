import type { Manifest, MountedBy } from './types.js';

/** Whether the manifest loads this entry's class itself. */
export const loadsFromManifest = (entry: { mountedBy?: MountedBy }): boolean => entry.mountedBy === undefined;

/**
 * Controllers a subclass replaces through `DI.register(Sub).as(Base)`: the runtime mounts only the subclass. A conditional
 * registration is left out, since only a boot decides it.
 */
export function overriddenControllers(manifest: Manifest): Set<string> {
  const overriding = new Map<string, Set<string>>();
  for (const s of manifest.services) {
    if (s.condition) continue;
    overriding.set(s.className, new Set([...(overriding.get(s.className) ?? []), ...s.registeredAs]));
  }
  const out = new Set<string>();
  for (const sub of manifest.controllers) {
    const replaced = overriding.get(sub.className);
    if (!replaced) continue;
    for (const baseId of sub.bases ?? []) {
      const base = manifest.controllers.find((c) => c.id === baseId);
      if (base && replaced.has(base.className)) out.add(base.id);
    }
  }
  return out;
}

/**
 * The manifest as a generated document or a diff describes it. An entry with `mountedBy` serves something only if a
 * registration ran, which nothing static can tell, so it is kept out; the runtime still reads it from the manifest itself.
 */
export function publishedManifest(manifest: Manifest): Manifest {
  const overridden = overriddenControllers(manifest);
  return {
    ...manifest,
    controllers: manifest.controllers.filter((c) => loadsFromManifest(c) && !overridden.has(c.id)),
    socketControllers: manifest.socketControllers.filter(loadsFromManifest),
    schedules: manifest.schedules.filter(loadsFromManifest),
    commands: manifest.commands.filter(loadsFromManifest),
    migrations: manifest.migrations.filter(loadsFromManifest),
  };
}
