import ts from 'typescript';
import { join, relative } from 'node:path';

/** Manifest sections that discovery fills by scanning a `system.dirs.*` key. */
export const DIR_SECTIONS = { controllers: 'controllers', socketControllers: 'socketControllers', schedules: 'schedules', cli: 'commands', migrations: 'migrations' } as const;

export type DirSection = (typeof DIR_SECTIONS)[keyof typeof DIR_SECTIONS];

/** Source dirs (relative to `src/`) a package declares per section; `undefined` means "not known statically, list everything". */
export type DeclaredDirs = Partial<Record<DirSection, string[] | undefined>>;

const BUILD_DIRS = new Set(['lib', 'dist', 'build', 'src']);

// Config files write `dir('cli')`, `join(root, 'node_modules', '@spinajs', 'x', 'lib', 'cli')` and the like: what is left
// after the install prefix and the build dir is the path below `src/`.
function dirFromLiteral(text: string): string {
  const parts = text.split(/[\\/]/).filter((p) => p !== '' && p !== '.' && p !== '..');
  const at = parts.map((p) => BUILD_DIRS.has(p)).lastIndexOf(true);
  return parts.slice(at + 1).join('/');
}

function literalsOf(node: ts.Node, out: string[]): void {
  if (ts.isStringLiteralLike(node)) out.push(node.text);
  ts.forEachChild(node, (child) => literalsOf(child, out));
}

const unwrap = (e: ts.Expression): ts.Expression => (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression(e) ? unwrap(e.expression) : e);

function dirsOf(initializer: ts.Expression): string[] | undefined {
  const literals: string[] = [];
  literalsOf(initializer, literals);
  const dirs = literals.map(dirFromLiteral).filter((d) => d !== '');
  // `[]` declares nothing; anything else without a literal (a variable, a call) cannot be read here
  return dirs.length > 0 || (ts.isArrayLiteralExpression(unwrap(initializer)) && (unwrap(initializer) as ts.ArrayLiteralExpression).elements.length === 0) ? dirs : undefined;
}

const keyName = (name: ts.PropertyName): string | undefined => (ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined);

function collect(node: ts.Node, found: DeclaredDirs): void {
  if (ts.isPropertyAssignment(node) && keyName(node.name) === 'dirs' && ts.isObjectLiteralExpression(node.initializer)) {
    for (const prop of node.initializer.properties) {
      const key = ts.isPropertyAssignment(prop) ? keyName(prop.name) : undefined;
      const section = key ? DIR_SECTIONS[key as keyof typeof DIR_SECTIONS] : undefined;
      if (!section || !ts.isPropertyAssignment(prop)) continue;
      const dirs = dirsOf(prop.initializer);
      const known = section in found;
      // one unreadable declaration makes the whole section unknown
      found[section] = dirs === undefined || (known && found[section] === undefined) ? undefined : [...(found[section] ?? []), ...dirs];
    }
  }
  ts.forEachChild(node, (child) => collect(child, found));
}

/** The `system.dirs.*` a package's own config files (`src/config/**`) declare, as paths below `src/`. */
export function declaredDirsOf(files: readonly ts.SourceFile[], packageRoot: string): DeclaredDirs {
  const found: DeclaredDirs = {};
  const configDir = join(packageRoot, 'src', 'config');
  for (const file of files) {
    if (!relative(configDir, file.fileName).startsWith('..') && !file.fileName.endsWith('.d.ts')) collect(file, found);
  }
  return found;
}

/** Whether `file` (a `src/...` path) is under one of the declared dirs; an unknown declaration lists everything. */
export function isUnderDeclaredDirs(file: string, section: DirSection, declared: DeclaredDirs): boolean {
  if (section in declared && declared[section] === undefined) return true;
  return (declared[section] ?? []).some((d) => file.startsWith(`src/${d}/`));
}
