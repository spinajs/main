import type { ControllerEntry, Manifest, MountedBy } from './types.js';

/** Whether the manifest loads this entry's class itself. */
export const loadsFromManifest = (entry: { mountedBy?: MountedBy }): boolean => entry.mountedBy === undefined;

interface Override {
  base: ControllerEntry;
  sub: ControllerEntry;
}

function overridesOf(manifest: Manifest): Override[] {
  const overriding = new Map<string, Set<string>>();
  for (const s of manifest.services) {
    if (s.condition) continue;
    overriding.set(s.className, new Set([...(overriding.get(s.className) ?? []), ...s.registeredAs]));
  }
  const out: Override[] = [];
  for (const sub of manifest.controllers) {
    const replaced = overriding.get(sub.className);
    if (!replaced) continue;
    for (const baseId of sub.bases ?? []) {
      const base = manifest.controllers.find((c) => c.id === baseId);
      if (base && replaced.has(base.className)) out.push({ base, sub });
    }
  }
  return out;
}

/**
 * Controllers a subclass replaces through `DI.register(Sub).as(Base)`: the runtime mounts only the subclass. A conditional
 * registration is left out, since only a boot decides it.
 */
export function overriddenControllers(manifest: Manifest): Set<string> {
  return new Set(overridesOf(manifest).map((o) => o.base.id));
}

/**
 * Subclasses outside the dirs that the runtime mounts anyway: the manifest loads the base they replace, and DI resolves
 * its slot to them. Two candidates for one base, such as an abandoned copy, leave the choice to the boot.
 */
function servedInBaseSlot(manifest: Manifest, overrides: Override[]): Set<ControllerEntry> {
  const subsByBase = new Map<string, Set<ControllerEntry>>();
  for (const { base, sub } of overrides) subsByBase.set(base.id, (subsByBase.get(base.id) ?? new Set()).add(sub));
  const out = new Set<ControllerEntry>();
  for (const [baseId, subs] of subsByBase) {
    const [only, ...others] = subs;
    const baseLoaded = manifest.controllers.some((c) => c.id === baseId && loadsFromManifest(c));
    if (baseLoaded && others.length === 0 && !loadsFromManifest(only)) out.add(only);
  }
  return out;
}

/**
 * The manifest as a generated document or a diff describes it. An entry with `mountedBy` serves something only if a
 * registration ran, which nothing static can tell, so it is kept out; the runtime still reads it from the manifest itself.
 */
export function publishedManifest(manifest: Manifest): Manifest {
  const overrides = overridesOf(manifest);
  const overridden = new Set(overrides.map((o) => o.base.id));
  const inBaseSlot = servedInBaseSlot(manifest, overrides);
  return {
    ...manifest,
    controllers: manifest.controllers.filter((c) => (loadsFromManifest(c) || inBaseSlot.has(c)) && !overridden.has(c.id)),
    socketControllers: manifest.socketControllers.filter(loadsFromManifest),
    schedules: manifest.schedules.filter(loadsFromManifest),
    commands: manifest.commands.filter(loadsFromManifest),
    migrations: manifest.migrations.filter(loadsFromManifest),
  };
}
