import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Diagnostic, SourceRef } from '@spinajs/manifest';
import { compareCodeUnits } from '../sort.js';
import { DIR_SECTIONS, type DirSection } from './declared-dirs.js';

/**
 * The app's `system.dirs` as its runtime resolves them, by key. The compiler never evaluates config, so a caller that can
 * (`spinajs build`) hands them in. A relative dir is read from the app root.
 */
export type EffectiveDirs = Readonly<Partial<Record<string, readonly string[]>>>;

/** Absolute paths. `rootDir` is what tsc strips from a source path to get its place under `outDir`. */
export interface AppLayout {
  root: string;
  rootDir: string;
  outDir: string;
}

export type ScannedEntry = { className: string; source: SourceRef };

const KEY_OF = Object.fromEntries(Object.entries(DIR_SECTIONS).map(([key, section]) => [section, key])) as Record<DirSection, string>;

function below(parent: string, path: string): string | undefined {
  const rel = relative(parent, path);
  return rel.split(sep)[0] === '..' || isAbsolute(rel) ? undefined : rel;
}

// The manifest runtime resolves `src/x` to `<outDir>/x` whatever the rootDir, and a tsconfig that also compiles tests has
// the app root as rootDir while the build that produced the dir used another one: both readings of a built dir count.
function sourceDirsOf(dir: string, layout: AppLayout): string[] {
  const path = resolve(layout.root, dir);
  const built = below(layout.outDir, path);
  const inside = built ?? below(layout.rootDir, path);
  if (inside === undefined) return below(path, layout.rootDir) === undefined ? [] : [layout.rootDir];
  if (inside.split(sep).includes('node_modules')) return [];
  return built === undefined ? [path] : [join(layout.rootDir, built), join(layout.root, 'src', built)];
}

const shown = (path: string, root: string): string => relative(root, path).split(sep).join('/') || '.';

/**
 * Keeps what discovery would load for a section. With no dir of the section inside the app, nothing says where its
 * classes belong: an uncompiled `lib/config`, a build run from another folder and an app that declares none look the
 * same from here, so its classes stay and each gets a warning, instead of the section going empty.
 *
 * `isRegistered` names classes discovery finds without a dir.
 */
export function discoveredBy(dirs: EffectiveDirs, layout: AppLayout, isRegistered: (section: DirSection, className: string) => boolean, report: (diagnostic: Diagnostic) => void) {
  return <T extends ScannedEntry>(section: DirSection, entries: T[]): T[] => {
    const key = KEY_OF[section];
    const sourceDirs = (dirs[key] ?? []).flatMap((d) => sourceDirsOf(d, layout));
    const searched = [...new Set(sourceDirs.map((d) => shown(d, layout.root)))].sort(compareCodeUnits).join(', ');

    return entries.filter(({ className, source }) => {
      if (isRegistered(section, className)) return true;
      const label = `${className} (${source.file})`;
      if (sourceDirs.length === 0) {
        const message = `${label} stays in the manifest, but no system.dirs.${key} entry lies in this app, so discovery would not load it: declare its folder there, and run the build from the app's folder after compiling its config`;
        report({ code: 'CMP007', severity: 'warning', message, source });
        return true;
      }
      const found = sourceDirs.some((d) => below(d, resolve(layout.root, source.file)) !== undefined);
      if (!found) {
        const message = `${label} is left out of the manifest: system.dirs.${key} searches ${searched}, where discovery does not find it. Move it there or declare its folder; a class that an import or a source registers needs no entry`;
        report({ code: 'CMP006', severity: 'warning', message, source });
      }
      return found;
    });
  };
}
