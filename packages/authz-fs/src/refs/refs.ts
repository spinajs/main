import { GLOBAL } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { InvalidArgument } from '@spinajs/exceptions';

import { normalizeFsPath } from './paths.js';

export type FsPathKind = 'file' | 'dir';
export type FsRefType = 'fs' | FsPathKind;

export const FS_RESOURCE_TYPES: readonly FsRefType[] = Object.freeze(['fs', 'dir', 'file'] as const);

export interface ParsedFsRef {
  readonly fs: string;
  /** Normalised; '' for the filesystem root. */
  readonly path: string;
  readonly type: FsRefType;
}

// The first ':' of a file or dir id ends the fs name, so a name must not hold one.
const isFsName = (name: unknown): name is string => typeof name === 'string' && name.length > 0 && !name.includes(':');

/** `{ type: 'fs', id: fsName }` for the root, else `{ type: kind, id: '<fsName>:<normalised path>' }`. */
export function fsRef(fsName: string, path: string, kind: FsPathKind): ResourceRef {
  if (!isFsName(fsName)) {
    throw new InvalidArgument(`fs name must be a non-empty string without ':', got ${JSON.stringify(fsName)}`, 'fsName');
  }
  if (kind !== 'file' && kind !== 'dir') {
    throw new InvalidArgument(`fs ref kind must be 'file' or 'dir', got ${JSON.stringify(kind)}`, 'kind');
  }
  const normalised = normalizeFsPath(path);
  return normalised === '' ? { type: 'fs', id: fsName } : { type: kind, id: `${fsName}:${normalised}` };
}

/** undefined for a ref that is not an fs ref, or whose id is not in the form fsRef builds. */
export function parseFsRef(ref: ResourceRef): ParsedFsRef | undefined {
  if (!ref || typeof ref.id !== 'string') {
    return undefined;
  }
  if (ref.type === 'fs') {
    return isFsName(ref.id) ? { fs: ref.id, path: '', type: 'fs' } : undefined;
  }
  if (ref.type !== 'file' && ref.type !== 'dir') {
    return undefined;
  }
  const at = ref.id.indexOf(':');
  const fs = ref.id.slice(0, at);
  const path = ref.id.slice(at + 1);
  if (at <= 0 || path === '' || !isCanonical(path)) {
    return undefined;
  }
  return { fs, path, type: ref.type };
}

/**
 * `[self, parent dirs nearest first, fs, GLOBAL]`, null for a ref parseFsRef refuses. Resolver (domain)
 * parents are not ancestors; the fs-inherit model reads them (design §13). This does not know which
 * filesystems exist: an fs name no provider has still gets a chain.
 */
export function fsAncestors(ref: ResourceRef): readonly ResourceRef[] | null {
  const parsed = parseFsRef(ref);
  if (!parsed) {
    return null;
  }

  const chain: ResourceRef[] = [];
  if (parsed.type !== 'fs') {
    chain.push({ type: parsed.type, id: `${parsed.fs}:${parsed.path}` });
    const segments = parsed.path.split('/');
    for (let n = segments.length - 1; n > 0; n--) {
      chain.push({ type: 'dir', id: `${parsed.fs}:${segments.slice(0, n).join('/')}` });
    }
  }
  chain.push({ type: 'fs', id: parsed.fs }, GLOBAL);
  return chain;
}

function isCanonical(path: string): boolean {
  try {
    return normalizeFsPath(path) === path;
  } catch {
    return false;
  }
}
