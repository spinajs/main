/** How Express 5 tells routes apart: case-insensitive, parameter and wildcard names do not matter. */
export function routeMatchKey(fullPath: string): string {
  return fullPath
    .toLowerCase()
    .replace(/:(?:"[^"]*"|[a-z_$][\w$]*)/g, ':')
    .replace(/\*(?:"[^"]*"|[a-z_$][\w$]*)/g, '*');
}
