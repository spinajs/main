import { fileURLToPath } from 'node:url';

/** The path of a `file:` url, in forward slashes like the paths a glob scan gives. `windows` picks whose path rules apply. */
export function filePathOfUrl(url: string, windows = process.platform === 'win32'): string {
  const path = fileURLToPath(url, { windows });
  return windows ? path.replaceAll('\\', '/') : path;
}
