import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log-common';
import type { EngineLog } from '../engine/authorizer.js';

/** EngineLog plus `info`, which the audit trail needs. */
export interface HostLog extends EngineLog {
  info(message: string, ...args: unknown[]): void;
}

type Level = 'error' | 'warn' | 'info' | 'debug';

const FALLBACK: HostLog = {
  error: (message, ...args) => console.error(message, ...args),
  warn: (message, ...args) => console.warn(message, ...args),
  info: (message, ...args) => console.info(message, ...args),
  debug: () => {},
};

/** `resolveLog` is a test seam; production code passes only the name. */
export function engineLog(name: string, resolveLog: (name: string) => Log | undefined = (n) => (DI.check(Log) ? (DI.resolve(Log, [n]) as Log) : undefined)): HostLog {
  let log: Log | undefined;
  const target = (): Log | undefined => {
    // Not cached until a Log exists, so one registered later is picked up; never resolved when unregistered.
    if (log === undefined) {
      try {
        log = resolveLog(name);
      } catch {
        return undefined;
      }
    }
    return log;
  };
  const write =
    (level: Level) =>
    (message: string, ...args: unknown[]): void => {
      try {
        const l = target();
        const fn = l?.[level] as ((...a: unknown[]) => void) | undefined;
        if (l !== undefined && typeof fn === 'function') {
          fn.call(l, message, ...args);
          return;
        }
      } catch {
        // fall through to the console fallback
      }
      try {
        FALLBACK[level](message, ...args);
      } catch {
        // logging never throws
      }
    };
  return { error: write('error'), warn: write('warn'), info: write('info'), debug: write('debug') };
}
