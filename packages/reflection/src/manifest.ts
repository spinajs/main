import { AsyncService, ClassInfo, DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { InternalLogger } from '@spinajs/internal-logger';
import { effectiveManifestOf } from '@spinajs/configuration';
import { existsSync } from 'node:fs';
import { isPackageSkipped, loadsFromManifest, manifestFileFor, ManifestMissing } from '@spinajs/manifest';
import type { Manifest, ManifestSection, MountedBy, SourceRef } from '@spinajs/manifest';

export type { ManifestSection };
export { ManifestMissing };

// Their classes register themselves as their module is evaluated, so an import is all they need, exported or not.
const REGISTERS_ON_IMPORT: ReadonlySet<ManifestSection> = new Set(['socketControllers', 'schedules', 'migrations']);

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

function effectiveOf(container: IContainer, section: ManifestSection) {
  try {
    return effectiveManifestOf(container);
  } catch (err) {
    if (err instanceof ManifestMissing) {
      throw new ManifestMissing(`${err.message}; section ${section} cannot be listed`);
    }
    throw err;
  }
}

export interface ManifestEntryRef {
  className: string;
  mountedBy?: MountedBy;
  source: SourceRef;
}

/**
 * Orders listed classes the way a directory scan does: `glob` sorts matches by `localeCompare(..., 'en')`. The compiler
 * sorts by code unit instead, to keep manifest hashes stable across machines. Extensions are ignored, as a compiled
 * manifest names `.js` where a scan under ts-node finds `.ts`.
 */
export function inScanOrder<T extends { file: string }>(listed: T[], group: (item: T) => number = () => 0): T[] {
  const key = (item: T): string => item.file.replace(/\\/g, '/').replace(/\.[mc]?[jt]s$/, '');
  return [...listed].sort((a, b) => group(a) - group(b) || key(a).localeCompare(key(b), 'en'));
}

/**
 * ClassInfo list for a manifest section, or undefined when the caller should scan directories instead
 * ( mode `off`, or `prefer` without a manifest ). An empty array is a real empty section. Every listed file
 * is imported once and the export named `className` is the type; the file comes from `manifestFileFor`, which
 * keeps it inside the package root. `include` drops entries before their file is imported.
 */
export async function listFromManifest(
  container: IContainer,
  section: ManifestSection,
  include?: (entry: ManifestEntryRef) => boolean,
): Promise<Array<ClassInfo<unknown>> | undefined> {
  const effective = effectiveOf(container, section);
  if (!effective?.manifest) {
    return undefined;
  }
  const { manifest, settings } = effective;
  const mode = settings.mode;

  const byFile = new Map<string, ManifestEntryRef[]>();
  const skipped = new Set<string>();
  const scanFiles = (manifest.scanFiles ?? []).filter((f) => f.section === section).map((f) => ({ className: '', source: f.source }));
  for (const entry of manifest[section] as ManifestEntryRef[]) {
    if (!loadsFromManifest(entry) || (include && !include(entry))) continue;
    const pkg = entry.source.package;
    if (!skipped.has(pkg) && isPackageSkipped(pkg, manifest, process.cwd(), mode)) {
      skipped.add(pkg);
      InternalLogger.debug({ name: pkg, section }, 'Package ${name} is listed in the manifest but not installed, its ${section} are skipped', 'Reflection');
    }
    if (skipped.has(pkg)) continue;
    const file = manifestFileFor(entry, manifest, process.cwd());
    byFile.set(file, [...(byFile.get(file) ?? []), entry]);
  }

  // The tsconfig of a build may hold a file the emit leaves out, and then no scan finds it either.
  for (const entry of scanFiles) {
    if (include && !include(entry)) continue;
    const file = manifestFileFor(entry, manifest, process.cwd());
    if (existsSync(file) && !byFile.has(file)) byFile.set(file, []);
  }

  const result: Array<ClassInfo<unknown>> = [];

  for (const [file, entries] of byFile) {
    const loaded = (await DI.__spinajs_require__(file)) as Record<string, unknown> | (Class<unknown> & { name: string });
    // __spinajs_require__ unwraps a default export to the class itself
    const exported: Record<string, unknown> = typeof loaded === 'function' ? { [loaded.name]: loaded } : loaded;

    for (const entry of entries) {
      // `export const Visible = Hidden`: a scan goes by the value, whatever the export is called.
      const type = exported[entry.className] ?? Object.values(exported).find((v) => typeof v === 'function' && v.name === entry.className);
      if (typeof type !== 'function') {
        if (REGISTERS_ON_IMPORT.has(section)) continue;
        throw new ManifestMissing(listedMissing(file, entry, section, manifest));
      }
      result.push(Object.assign(new ClassInfo<unknown>(), { file, name: entry.className, type: type as Class<unknown>, instance: undefined }));
    }
  }

  return result;
}

function listedMissing(file: string, entry: ManifestEntryRef, section: ManifestSection, manifest: Manifest): string {
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
