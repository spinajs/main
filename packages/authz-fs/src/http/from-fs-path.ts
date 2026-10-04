import type { ResourceRef } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';

import { basePathOf, publishedFs, refOf } from '../guard/shared.js';
import { normalizeFsPath } from '../refs/index.js';

/**
 * A resource extractor for `@Access` (authz-http's `ResourceExtractor`): the `file` ref of the url parameter
 * `param` on `fsName`, the `fs` ref for the root. The path is normalised as the guard does (D3), with the base path
 * of the published provider, so the ref is the one the guard checks for the same path. Only url parameters are
 * read, as authz-http's `fromParam` does.
 *
 * @throws InvalidArgument (400) when the parameter is missing or not a string, or the path is refused
 */
export function fromFsPath(fsName: string, param: string): (req: unknown) => ResourceRef | Promise<ResourceRef> {
  if (typeof fsName !== 'string' || fsName === '' || fsName.includes(':')) {
    throw new InvalidArgument(`fs name must be a non-empty string without ':', got ${JSON.stringify(fsName)}`, 'fsName');
  }
  if (typeof param !== 'string' || param === '') throw new InvalidArgument(`url parameter name must be a non-empty string, got ${JSON.stringify(param)}`, 'param');

  return (req: unknown): ResourceRef => {
    const params: unknown = req !== null && typeof req === 'object' ? (req as { params?: unknown }).params : undefined;
    const value: unknown = params !== null && typeof params === 'object' && Object.hasOwn(params, param) ? (params as Record<string, unknown>)[param] : undefined;
    if (typeof value !== 'string') throw new InvalidArgument(`url parameter ${param} is required to identify a file of ${fsName}`, param);
    return refOf(fsName, normalizeFsPath(value, basePathOf(publishedFs(DI.RootContainer, fsName))), 'file');
  };
}
