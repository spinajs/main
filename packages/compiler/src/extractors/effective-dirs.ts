import ts from 'typescript';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Diagnostic, MountedBy, SourceRef } from '@spinajs/manifest';
import { compareCodeUnits } from '../sort.js';
import { DIR_SECTIONS, type DirSection } from './declared-dirs.js';

/**
 * The app's `system.dirs` as its runtime resolves them, by key. The compiler never evaluates config, so a caller that can
 * (`spinajs build`) hands them in. A relative dir is read from the app root.
 */
export type EffectiveDirs = Readonly<Partial<Record<string, readonly string[]>>>;

/** What a caller knows of the app's dirs. */
export interface AppDirs {
  effectiveDirs: EffectiveDirs;
  /** Dirs that apply while a key is empty. They exist without any config, so they filter their section but prove nothing. */
  defaultDirs?: EffectiveDirs;
  /** Throw `NoAppDirs` when no configured dir lies in the app. Otherwise that means the app declares none. */
  requireAppDirs?: boolean;
}

/** No configured dir of any section lies in the app, so its config was not seen the way the runtime sees it. */
export class NoAppDirs extends Error {}

/** Absolute paths. `rootDir` is what tsc strips from a source path to get its place under `outDir`. */
export interface AppLayout {
  root: string;
  rootDir: string;
  outDir: string;
}

export interface ScannedEntry {
  className: string;
  mountedBy?: MountedBy;
  source: SourceRef;
}

/** What is known of the app's sources: enough to answer what a scan of a folder imports. */
export interface AppSources {
  checker: ts.TypeChecker;
  files: readonly ts.SourceFile[];
}

const KEY_OF = Object.fromEntries(Object.entries(DIR_SECTIONS).map(([key, section]) => [section, key])) as Record<DirSection, string>;

function below(parent: string, path: string): string | undefined {
  const rel = relative(parent, path);
  return rel.split(sep)[0] === '..' || isAbsolute(rel) ? undefined : rel;
}

// The manifest runtime resolves `src/x` to `<outDir>/x` whatever the rootDir, and a tsconfig that also compiles tests has
// the app root as rootDir while the build that produced the dir used another one: both readings of a built dir count.
// A folder with no sources behind it maps nothing, however the dir was computed.
function sourceDirsOf(dir: string, layout: AppLayout): string[] {
  const path = resolve(layout.root, dir);
  if (below(path, layout.rootDir) !== undefined || below(path, layout.outDir) !== undefined) return [layout.rootDir];
  const built = below(layout.outDir, path);
  const inside = built ?? below(layout.rootDir, path);
  if (inside === undefined || inside.split(sep).includes('node_modules')) return [];
  const readings = built === undefined ? [path] : [join(layout.rootDir, built), join(layout.root, 'src', built)];
  return readings.filter((d) => existsSync(d));
}

const shown = (path: string, root: string): string => relative(root, path).split(sep).join('/') || '.';

const classKey = (file: string, className: string): string => `${file}#${className}`;

const isTypeOnlyExport = (symbol: ts.Symbol): boolean => (symbol.declarations ?? []).some((d) => ts.isTypeOnlyExportDeclaration(d));

/** Classes `files` export at runtime, wherever they are declared: what importing those files hands a scan. */
function exportedClasses({ checker, files }: AppSources, root: string): Set<string> {
  const found = new Set<string>();
  for (const file of files) {
    const module = checker.getSymbolAtLocation(file);
    for (const exported of module ? checker.getExportsOfModule(module) : []) {
      if (isTypeOnlyExport(exported)) continue;
      const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      for (const declaration of target.declarations ?? []) {
        if (!ts.isClassDeclaration(declaration) || !declaration.name) continue;
        found.add(classKey(shown(resolve(declaration.getSourceFile().fileName), root), declaration.name.text));
      }
    }
  }
  return found;
}

function searchedDirs(dirs: EffectiveDirs, root: string): string {
  const listed = Object.values(KEY_OF).flatMap((key) => {
    const own = (dirs[key] ?? []).map((d) => resolve(root, d)).filter((d) => !d.split(sep).includes('node_modules'));
    return own.length > 0 ? [`${key}: ${own.map((d) => shown(d, root)).join(', ')}`] : [];
  });
  return listed.length > 0 ? listed.join('; ') : 'none';
}

/**
 * Marks what discovery would not load for a section. Such an entry keeps its metadata for a class a registration may still
 * bring in, but the manifest does not load it. A section with no dir in the app is empty, as it is for discovery.
 */
export function discoveredBy({ effectiveDirs, defaultDirs = {}, requireAppDirs }: AppDirs, layout: AppLayout, sources: AppSources, report: (diagnostic: Diagnostic) => void) {
  const mapped = (key: string): string[] => (effectiveDirs[key] ?? []).flatMap((d) => sourceDirsOf(d, layout));

  if (requireAppDirs && !Object.values(KEY_OF).some((key) => mapped(key).length > 0)) {
    throw new NoAppDirs(`no system.dirs entry maps to a source folder of this app. Searched ${searchedDirs(effectiveDirs, layout.root)}`);
  }

  return <T extends ScannedEntry>(section: DirSection, entries: T[]): T[] => {
    const key = KEY_OF[section];
    const sourceDirs = effectiveDirs[key]?.length ? mapped(key) : (defaultDirs[key] ?? []).flatMap((d) => sourceDirsOf(d, layout));
    const scanned = sources.files.filter((f) => sourceDirs.some((d) => below(d, resolve(f.fileName)) !== undefined));
    const reachable = exportedClasses({ ...sources, files: scanned }, layout.root);
    const searched = [...new Set(sourceDirs.map((d) => shown(d, layout.root)))].sort(compareCodeUnits).join(', ');
    const missing = searched ? `no file under ${searched} (system.dirs.${key}) exports it` : `system.dirs.${key} names no source folder of this app`;

    return entries.map((entry) => {
      const { className, source } = entry;
      if (reachable.has(classKey(source.file, className))) return entry;
      const message = `${className} (${source.file}) is not loaded from the manifest: ${missing}, so discovery does not find it. It runs only if something registers it; otherwise move it there or declare its folder`;
      report({ code: 'CMP006', severity: 'warning', message, source });
      return { ...entry, mountedBy: 'di' };
    });
  };
}
