import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log-common';
export { thrownError } from '../engine/vote.js';

const METHODS = ['trace', 'debug', 'info', 'success', 'warn', 'error', 'fatal', 'security', 'warnOnce'] as const;

/** The log the engine, the host and the authz packages write with. */
export type AuthzLog = Pick<Log, (typeof METHODS)[number]>;

/** @deprecated Use {@link AuthzLog}. */
export type HostLog = Pick<AuthzLog, 'error' | 'warn' | 'info' | 'debug'>;

function registeredLog(name: string): Log {
  if (!DI.check(Log)) {
    throw new Error(`authz: no Log is registered, so the logger '${name}' cannot write; register @spinajs/log (or another Log implementation) first`);
  }
  return DI.resolve(Log, [name]);
}

/**
 * The Log `name`, resolved on its first write so the writer can be created before a Log is registered. Throws when
 * none is registered at that write. `resolveLog` is a test seam; production code passes only the name.
 */
export function engineLog(name: string, resolveLog: (name: string) => Log = registeredLog): AuthzLog {
  let log: Log | undefined;
  const writer: Record<string, unknown> = {};
  for (const method of METHODS) {
    writer[method] = (...args: unknown[]) => {
      log ??= resolveLog(name);
      return (log[method] as (...a: unknown[]) => unknown).apply(log, args);
    };
  }
  return writer as AuthzLog;
}
