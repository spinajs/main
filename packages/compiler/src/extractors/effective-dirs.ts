import ts from 'typescript';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { matchesMigrationGlob, matchesScanGlob, type Diagnostic, type MountedBy, type ScanFile, type SourceRef } from '@spinajs/manifest';
import { compareCodeUnits } from '../sort.js';
import { DIR_SECTIONS, type DirSection } from './declared-dirs.js';
import { EmittedModules } from './emitted-modules.js';

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

/** What is known of the app's sources: enough to answer what a scan of a folder brings in. */
export interface AppSources {
  checker: ts.TypeChecker;
  options: ts.CompilerOptions;
  files: readonly ts.SourceFile[];
  packageName: string;
}

// A scan imports every file of a section. These two then read the exports of what it imported; the other three register
// themselves as their module is evaluated, so whatever that import loads counts, exported or not.
const READ_FROM_EXPORTS: ReadonlySet<DirSection> = new Set(['controllers', 'commands']);

// Migrations leave a dotted name to the runtime, which knows the environment: only there the glob is complete.
const inSectionGlob = (section: DirSection, built: string): boolean => (section === 'migrations' ? matchesMigrationGlob(built) : matchesScanGlob(built));

const builtName = (file: string): string => file.replace(/\.tsx?$/, '.js').replace(/\.mts$/, '.mjs').replace(/\.cts$/, '.cjs');

const isEnvTagged = (file: string): boolean => matchesMigrationGlob(file) && !matchesMigrationGlob(file, '');

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
  const modules = new EmittedModules(sources.checker, sources.options);
  const scanFiles: ScanFile[] = [];
  const mapped = (key: string): string[] => (effectiveDirs[key] ?? []).flatMap((d) => sourceDirsOf(d, layout));
  const inApp = (file: ts.SourceFile): string => shown(resolve(file.fileName), layout.root);

  const reachedBy = (section: DirSection, scanned: ts.SourceFile[]): ((entry: ScannedEntry) => boolean) => {
    if (READ_FROM_EXPORTS.has(section)) {
      const classes = new Set(scanned.flatMap((f) => [...modules.exportsOf(f).values()]).map((c) => classKey(inApp(c.getSourceFile()), c.name?.text ?? '')));
      return ({ className, source }) => classes.has(classKey(source.file, className));
    }
    // A tagged file is imported in its environment only, so what it alone loads must not load in every other one.
    const tagged = scanned.filter((f) => isEnvTagged(builtName(f.fileName)));
    const files = new Set([...modules.closureOf(scanned.filter((f) => !tagged.includes(f))), ...tagged].map(inApp));
    return ({ source }) => files.has(source.file);
  };

  const reportUnmapped = (key: string): void => {
    for (const dir of effectiveDirs[key] ?? []) {
      const path = resolve(layout.root, dir);
      const rel = below(layout.root, path);
      if (rel === undefined || rel.split(sep).includes('node_modules') || sourceDirsOf(dir, layout).length > 0) continue;
      report({ code: 'CMP008', severity: 'warning', message: `system.dirs.${key} entry ${shown(path, layout.root)} has no source folder behind it, so it maps to nothing. If it was computed from the working directory, run the build from the folder the app runs from` });
    }
  };

  return {
    scanFiles,

    /** Called with the number of classes found: with none there is nothing to get wrong. */
    requireDirs(found: number): void {
      if (requireAppDirs && found > 0 && !Object.values(KEY_OF).some((key) => mapped(key).length > 0)) {
        throw new NoAppDirs(`no system.dirs entry maps to a source folder of this app. Searched ${searchedDirs(effectiveDirs, layout.root)}`);
      }
    },

    filter<T extends ScannedEntry>(section: DirSection, entries: T[]): T[] {
      const key = KEY_OF[section];
      reportUnmapped(key);
      const sourceDirs = effectiveDirs[key]?.length ? mapped(key) : (defaultDirs[key] ?? []).flatMap((d) => sourceDirsOf(d, layout));
      const scanned = sources.files.filter((f) => inSectionGlob(section, builtName(f.fileName)) && sourceDirs.some((d) => below(d, resolve(f.fileName)) !== undefined));
      const reached = reachedBy(section, scanned);
      const searched = [...new Set(sourceDirs.map((d) => shown(d, layout.root)))].sort(compareCodeUnits).join(', ');
      const verb = READ_FROM_EXPORTS.has(section) ? 'exports' : 'imports';
      const missing = searched ? `no file under ${searched} (system.dirs.${key}) ${verb} it` : `system.dirs.${key} names no source folder of this app`;

      const marked = entries.map((entry) => {
        const { className, source } = entry;
        if (reached(entry)) return entry;
        const message = `${className} (${source.file}) is not loaded from the manifest: ${missing}, so a directory scan does not bring it in. It runs only if something registers it; otherwise move it there or declare its folder`;
        report({ code: 'CMP006', severity: 'warning', message, source });
        return { ...entry, mountedBy: 'di' };
      });

      const loadedFiles = new Set(marked.filter((e) => e.mountedBy === undefined).map((e) => e.source.file));
      for (const file of scanned.map(inApp).filter((f) => !loadedFiles.has(f))) {
        scanFiles.push({ section, source: { file, line: 1, col: 1, package: sources.packageName } });
      }
      return marked;
    },
  };
}
