import type { Manifest, MountedBy } from './types.js';

/** Whether the manifest loads this entry's class itself. */
export const loadsFromManifest = (entry: { mountedBy?: MountedBy }): boolean => entry.mountedBy === undefined;

/**
 * The manifest as a generated document or a diff describes it. An entry with `mountedBy` serves something only if a
 * registration ran, which nothing static can tell, so it is kept out; the runtime still reads it from the manifest itself.
 */
export function publishedManifest(manifest: Manifest): Manifest {
  return {
    ...manifest,
    controllers: manifest.controllers.filter(loadsFromManifest),
    socketControllers: manifest.socketControllers.filter(loadsFromManifest),
    schedules: manifest.schedules.filter(loadsFromManifest),
    commands: manifest.commands.filter(loadsFromManifest),
    migrations: manifest.migrations.filter(loadsFromManifest),
  };
}
