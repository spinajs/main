import { optionalLog } from '@spinajs/log-common';
import type { Log, LogWriter } from '@spinajs/log-common';
export { thrownError } from '../engine/vote.js';

/** The log the engine, the host and the authz packages write with. */
export type AuthzLog = LogWriter;

/** @deprecated Use {@link AuthzLog}. */
export type HostLog = Pick<AuthzLog, 'error' | 'warn' | 'info' | 'debug'>;

/** Falls back to the console while no Log is registered. `resolveLog` is a test seam; production code passes only the name. */
export function engineLog(name: string, resolveLog?: (name: string) => Log | undefined): AuthzLog {
  return optionalLog(name, resolveLog);
}
