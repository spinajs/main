import { servedPath } from '@spinajs/manifest';

/** How Express 5 tells routes apart: trailing slashes, case and parameter or wildcard names do not matter. */
export function routeMatchKey(fullPath: string): string {
  return servedPath(fullPath)
    .toLowerCase()
    .replace(/:(?:"[^"]*"|[a-z_$][\w$]*)/g, ':')
    .replace(/\*(?:"[^"]*"|[a-z_$][\w$]*)/g, '*');
}
