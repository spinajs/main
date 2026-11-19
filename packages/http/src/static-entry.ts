import { InvalidOption } from '@spinajs/exceptions';

import type { IHttpStaticFileConfiguration } from './interfaces.js';

/**
 * Whether an `http.Static` entry is mounted. Strict, so a switch meant to keep a folder closed never opens it by
 * accident: `'false'` from an environment variable, `0` or `null` stop the start instead of mounting the folder.
 */
export function isMounted(entry: IHttpStaticFileConfiguration): boolean {
  // Read once: a ConfigVar behind the property runs on every read.
  const enabled: unknown = entry.Enabled;
  if (enabled === undefined || enabled === true) return true;
  if (enabled === false) return false;
  throw new InvalidOption(`http.Static entry ${entry.Route}: Enabled must be true, false or absent; got ${enabled === null ? 'null' : typeof enabled}`);
}
