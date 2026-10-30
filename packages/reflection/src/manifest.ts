import { AsyncService, ClassInfo, DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { manifestOf, manifestSettingsOf } from '@spinajs/configuration';
import { manifestFileFor, ManifestMissing } from '@spinajs/manifest';
import type { Manifest, ManifestMode, SourceRef } from '@spinajs/manifest';

export type ManifestSection = 'controllers' | 'socketControllers' | 'schedules' | 'commands' | 'migrations';

export interface ListOptions {
  /** Manifest section that lists the same classes as the scanned directories; defaults by `configPath`. */
  manifest?: ManifestSection;
}

export const MANIFEST_SECTIONS: Readonly<Record<string, ManifestSection>> = {
  'system.dirs.controllers': 'controllers',
  'system.dirs.socketControllers': 'socketControllers',
  'system.dirs.schedules': 'schedules',
  'system.dirs.cli': 'commands',
  'system.dirs.migrations': 'migrations',
};

/** The effective `system.manifest.mode` decided by `ManifestConfigurationSource`, never a later-merged config key. */
export function manifestMode(container: IContainer): ManifestMode {
  return manifestSettingsOf(container)?.mode ?? 'off';
}

interface Named {
  className: string;
  source: SourceRef;
}

/**
 * ClassInfo list for a manifest section, or undefined when the caller should scan directories instead
 * ( mode `off`, or `prefer` without a manifest ). An empty array is a real empty section. Every listed file
 * is imported once and the export named `className` is the type; the file comes from `manifestFileFor`, which
 * keeps it inside the package root.
 */
export async function listFromManifest(container: IContainer, section: ManifestSection, mode: ManifestMode): Promise<Array<ClassInfo<unknown>> | undefined> {
  if (mode === 'off') {
    return undefined;
  }

  const manifest = manifestOf(container);

  if (!manifest) {
    if (mode === 'require') {
      throw new ManifestMissing(`system.manifest.mode is 'require' but no manifest is registered; section ${section} cannot be listed`);
    }
    return undefined;
  }

  const byFile = new Map<string, Named[]>();
  for (const entry of manifest[section] as Named[]) {
    const file = manifestFileFor(entry, manifest, process.cwd());
    byFile.set(file, [...(byFile.get(file) ?? []), entry]);
  }

  const result: Array<ClassInfo<unknown>> = [];

  for (const [file, entries] of byFile) {
    const loaded = (await DI.__spinajs_require__(file)) as Record<string, unknown> | (Class<unknown> & { name: string });
    // __spinajs_require__ unwraps a default export to the class itself
    const exported: Record<string, unknown> = typeof loaded === 'function' ? { [loaded.name]: loaded } : loaded;

    for (const entry of entries) {
      const type = exported[entry.className];
      if (typeof type !== 'function') {
        throw new ManifestMissing(listedMissing(file, entry, section, manifest));
      }
      result.push(Object.assign(new ClassInfo<unknown>(), { file, name: entry.className, type: type as Class<unknown>, instance: undefined }));
    }
  }

  return result;
}

function listedMissing(file: string, entry: Named, section: ManifestSection, manifest: Manifest): string {
  return `${file} does not export class ${entry.className} listed in manifest section ${section} ( ${entry.source.file}:${entry.source.line}, manifest ${manifest.app.name} )`;
}

/** Resolves the listed classes through DI; a type that cannot be resolved is reported and dropped, as a directory scan does. */
export async function resolveListed(listed: Array<ClassInfo<unknown>>, onError: (err: unknown, ci: ClassInfo<unknown>) => void): Promise<Array<ClassInfo<unknown>>> {
  const out: Array<ClassInfo<unknown>> = [];

  for (const ci of listed) {
    try {
      const type = ci.type as Class<unknown>;
      const instance = type.prototype instanceof AsyncService ? await DI.resolve(type as Class<AsyncService>) : DI.resolve(type);
      out.push(Object.assign(new ClassInfo<unknown>(), { ...ci, instance }));
    } catch (err) {
      onError(err, ci);
    }
  }

  return out;
}
