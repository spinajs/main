import { lstatSync, readdirSync, type Dirent } from 'node:fs';
import { createRequire } from 'node:module';
import { posix, win32 } from 'node:path';

type Glob = typeof import('glob');
type Minimatch = typeof import('minimatch');

const load = createRequire(import.meta.url);
let globModule: Glob | undefined;
let minimatchModule: Minimatch | undefined;

/** Loaded only for a pattern the listing below does not reproduce, so a boot that never needs them never loads them. */
export const lazyGlob = (): Glob => (globModule ??= load('glob') as Glob);
const lazyMinimatch = (): Minimatch => (minimatchModule ??= load('minimatch') as Minimatch);

const WORD = '[\\w-]+';
const FILE_SOURCE_PATTERN = new RegExp(`^(?:!\\(\\*\\.\\*\\)|\\*\\.(${WORD}(?:\\.${WORD})*))\\.(?:\\{(${WORD}(?:,${WORD})+)\\}|(${WORD}))$`);

/**
 * The file-source patterns `!(*.*).<ext>` and `*.<env>.<ext>` ( `<ext>` one word or a `{a,b}` list ) as a test of one
 * file name that answers what minimatch answers, dot files excluded; undefined for any other pattern.
 */
export function fileNameMatcher(pattern: string): ((name: string) => boolean) | undefined {
  const parsed = FILE_SOURCE_PATTERN.exec(pattern);
  if (!parsed) return undefined;

  const [, env, list, single] = parsed;
  const extensions = list ? list.split(',') : [single];
  if (env === undefined) {
    return (name) => extensions.some((ext) => name.length > ext.length + 1 && name.endsWith(`.${ext}`) && !name.slice(0, -ext.length - 1).includes('.'));
  }
  return (name) => !name.startsWith('.') && extensions.some((ext) => name.endsWith(`.${env}.${ext}`));
}

/** `minimatch(path, '**\/' + pattern)` for a relative `/`-separated path. */
export function matchesInAnyDir(path: string, pattern: string): boolean {
  const matches = fileNameMatcher(pattern);
  if (!matches || !/^(?:[^/\\]+\/)*[^/\\]+$/.test(path)) {
    return lazyMinimatch()(path, `**/${pattern}`);
  }
  const parts = path.split('/');
  const name = parts.pop() as string;
  return parts.every((dir) => !dir.startsWith('.')) && matches(name);
}

// glob reads these as "nothing here"; any other error fails the listing
const NOTHING_HERE = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG', 'UNKNOWN', 'ENOTSUP']);

function entriesOf(dir: string): Dirent[] | undefined {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (NOTHING_HERE.has((err as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw err;
  }
}

/**
 * How glob's `**` treats an entry: a directory it walks, a symlink it lists one level of, or a file. Windows reports
 * every reparse point as a link in `readdir`, and an `lstat` failure other than ENOENT makes glob try `readdir`.
 */
function kindOf(entry: Dirent, path: string): 'dir' | 'link' | undefined {
  if (entry.isDirectory()) return 'dir';
  if (entry.isFile() || entry.isFIFO() || entry.isSocket() || entry.isCharacterDevice() || entry.isBlockDevice()) return undefined;
  try {
    const stats = lstatSync(path);
    return stats.isSymbolicLink() ? 'link' : stats.isDirectory() ? 'dir' : undefined;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : 'dir';
  }
}

function collect(dir: string, entries: Dirent[], walk: boolean, matches: (name: string) => boolean, found: string[]): void {
  for (const entry of entries) {
    if (matches(entry.name)) found.push(`${dir}/${entry.name}`);
  }
  if (!walk) return;

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const path = `${dir}/${entry.name}`;
    const kind = kindOf(entry, path);
    const children = kind && entriesOf(path);
    if (children) collect(path, children, kind === 'dir', matches, found);
  }
}

/** A directory glob takes literally, written the way glob writes the paths it returns. */
function isLiteralDir(dir: string): boolean {
  if (/[*?[\]{}\\]|[!?+*@]\(/.test(dir)) return false;
  return process.platform === 'win32' ? /^[A-Za-z]:\//.test(dir) && win32.normalize(dir).replace(/\\/g, '/') === dir : dir.startsWith('/') && !dir.startsWith('//') && posix.normalize(dir) === dir;
}

/**
 * `glob.sync(pattern)`, for a `<dir>/**\/<file-source pattern>` over a literal absolute directory read with one
 * `readdir` per directory instead of an `lstat` per entry. Same paths, same order, same errors; any other pattern goes to glob.
 */
export function listConfigFiles(pattern: string): string[] {
  const at = pattern.lastIndexOf('/**/');
  const matches = at > 0 ? fileNameMatcher(pattern.slice(at + 4)) : undefined;
  const dir = pattern.slice(0, at);
  if (!matches || !isLiteralDir(dir)) {
    return lazyGlob().sync(pattern);
  }

  const found: string[] = [];
  const entries = entriesOf(dir);
  if (entries) collect(dir, entries, true, matches, found);
  // glob's own order
  return found.sort((a, b) => a.localeCompare(b, 'en'));
}
