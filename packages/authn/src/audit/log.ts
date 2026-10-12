import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log-common';

// TODO: remove  and use native spinajs/log

export interface AuditLog {
  info(message: string): void;
  warn(message: string): void;
}

type Level = keyof AuditLog;

const defaultResolve = (name: string): Log | undefined => (DI.check(Log) ? (DI.resolve(Log, [name]) as Log) : undefined);

/** The named `Log` when one is registered, else the console; never throws. `resolveLog` is a test seam. */
export function auditLog(name: string, resolveLog: (name: string) => Log | undefined = defaultResolve): AuditLog {
  let log: Log | undefined;
  const write =
    (level: Level) =>
    (message: string): void => {
      try {
        // Not cached until a Log exists, so one registered later is picked up.
        log ??= resolveLog(name);
        const fn = log?.[level] as ((m: string) => void) | undefined;
        if (typeof fn === 'function') {
          fn.call(log, message);
          return;
        }
      } catch {
        // fall through to the console
      }
      try {
        console[level](message);
      } catch {
        // logging never throws
      }
    };
  return { info: write('info'), warn: write('warn') };
}
