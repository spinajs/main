import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type ts from 'typescript';
import { MANIFEST_VERSION, validateFragment, type ControllerEntry, type ManifestFragment, type SocketControllerEntry, type SourceRef } from '@spinajs/manifest';
import type { ExtractorContext } from './context.js';
import type { ExternalBases } from './extractors/inherited-routes.js';
import { owningPackage, type OwningPackage } from './owning-package.js';

interface Located {
  owner: OwningPackage;
  fragment?: ManifestFragment;
  problem?: string;
}

function readable(path: string): ManifestFragment | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  const version = (value as { manifestVersion?: unknown } | null)?.manifestVersion;
  return version === MANIFEST_VERSION && validateFragment(value).length === 0 ? (value as ManifestFragment) : undefined;
}

function load(owner: OwningPackage): Located {
  const path = owner.fragment ? join(owner.root, owner.fragment) : undefined;
  if (!path || !existsSync(path)) return { owner, problem: 'ships no manifest fragment' };
  const fragment = readable(path);
  return fragment ? { owner, fragment } : { owner, problem: 'has a manifest fragment this compiler cannot read' };
}

const stem = (file: string): string => file.replace(/\.d\.[mc]?ts$|\.[mc]?[jt]s$/, '');

/**
 * The entry for `declarationFile` among same-named ones: `lib/x/y.d.ts` of the dependency against `src/x/y.ts` in its
 * fragment. Only the outDir and rootDir differ, so of the sources ending in `x/y` the shortest is the module itself.
 */
function inModuleOf<T extends { source: SourceRef }>(entries: T[], declarationFile: string, located: Located): T | undefined {
  const outDir = located.fragment?.package.outDir ?? 'lib';
  const rel = stem(relative(located.owner.root, declarationFile).replaceAll('\\', '/'));
  const tail = rel.startsWith(`${outDir}/`) ? rel.slice(outDir.length + 1) : rel;
  const candidates = entries.map((e) => ({ e, declared: stem(e.source.file) })).filter(({ declared }) => declared === tail || declared.endsWith(`/${tail}`));
  return candidates.sort((a, b) => a.declared.length - b.declared.length)[0]?.e;
}

/**
 * Entries for base classes declared in other packages. Their declaration files carry no decorators, so the decorator facts
 * come from the owning package's manifest fragment; `withInheritedRoutes` re-types them through the checker as for a local base.
 */
export function dependencyBases(ctx: ExtractorContext): ExternalBases {
  const byRoot = new Map<string, Located>();
  const byFile = new Map<string, Located | undefined>();
  const reported = new Set<string>();

  const locateFile = (file: string): Located | undefined => {
    const owner = owningPackage(file);
    if (!owner || owner.name === ctx.packageName) return undefined;
    const located = byRoot.get(owner.root) ?? load(owner);
    byRoot.set(owner.root, located);
    return located;
  };

  const locate = (file: string): Located | undefined => {
    if (!byFile.has(file)) byFile.set(file, locateFile(file));
    return byFile.get(file);
  };

  const find = <T extends { className: string; source: SourceRef }>(decl: ts.ClassDeclaration, pick: (f: ManifestFragment) => T[]): T | undefined => {
    const className = decl.name?.text;
    const file = decl.getSourceFile().fileName;
    const located = className ? locate(file) : undefined;
    if (!className || !located) return undefined;
    if (!located.fragment) {
      const key = `${located.owner.name}:${className}`;
      if (!reported.has(key)) ctx.info('CMP009', `${className} from ${located.owner.name}, which ${located.problem}: the routes and handlers it declares are not in the manifest`);
      reported.add(key);
      return undefined;
    }
    const named = pick(located.fragment).filter((e) => e.className === className);
    return named.length <= 1 ? named[0] : inModuleOf(named, file, located);
  };

  return {
    controller: (decl) => find<ControllerEntry>(decl, (f) => [...f.controllers, ...(f.controllerBases ?? [])]),
    socketController: (decl) => find<SocketControllerEntry>(decl, (f) => [...f.socketControllers, ...(f.socketControllerBases ?? [])]),
  };
}
