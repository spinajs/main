import type { ResourceRef } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { _check_arg, _is_string, _non_empty, isStringArray } from '@spinajs/util';

import { basePathOf, publishedFs, refOf } from '../guard/shared.js';
import { checkFsName } from '../metadata/meta.js';
import { normalizeFsPath } from '../refs/index.js';

/**
 * A resource extractor for `@Access` (authz-http's `ResourceExtractor`): the `file` ref of the url parameter
 * `param` on `fsName`, the `fs` ref for the root. The path is normalised as the guard does (D3), with the base path
 * of the published provider, so the ref is the one the guard checks for the same path. Only url parameters are
 * read, as authz-http's `fromParam` does. An Express 5 wildcard (`*path`) gives an array of segments: they are
 * joined with '/', each segment refused on its own when the normaliser refuses it (`..` included).
 *
 * @param container - where the published provider is looked up; default the root container
 * @throws InvalidArgument (400) when the parameter is missing, not a string or a non-empty string array, or the
 * path is refused
 */
export function fromFsPath(fsName: string, param: string, container?: IContainer): (req: unknown) => ResourceRef | Promise<ResourceRef> {
  checkFsName(fsName);
  _check_arg(_is_string(_non_empty()))(param, 'param');

  return (req: unknown): ResourceRef => {
    const params: unknown = req !== null && typeof req === 'object' ? (req as { params?: unknown }).params : undefined;
    const value: unknown = params !== null && typeof params === 'object' && Object.hasOwn(params, param) ? (params as Record<string, unknown>)[param] : undefined;
    return refOf(fsName, normalizeFsPath(pathOf(value, param, fsName), basePathOf(publishedFs(container ?? DI.RootContainer, fsName))), 'file');
  };
}

function pathOf(value: unknown, param: string, fsName: string): string {
  if (typeof value === 'string') return value;
  if (isStringArray(value) && value.length > 0) {
    // A segment such as '..' is refused even where the joined path would stay inside the filesystem.
    for (const segment of value as string[]) if (segment === '' || segment.includes('/') || normalizeFsPath(segment) !== segment) throw new InvalidArgument(`url parameter ${param} has the segment ${JSON.stringify(segment)}`, param);
    return value.join('/');
  }
  throw new InvalidArgument(`url parameter ${param} is required to identify a file of ${fsName}`, param);
}
