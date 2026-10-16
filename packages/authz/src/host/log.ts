import { DI } from '@spinajs/di';
import { Log, renderTemplate } from '@spinajs/log-common';
export { thrownError } from '../engine/vote.js';

/** The Log methods the host and its models write with, fields form included. */
export type HostLog = Pick<Log, 'error' | 'warn' | 'info' | 'debug'>;

type Level = 'error' | 'warn' | 'info' | 'debug';

const isFields = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !(v instanceof Error) && !Array.isArray(v);

// The console has no layout: a fields-form call is rendered here as a Log would render it, and its error, which a layout prints, follows the line.
function consoleArgs(args: unknown[]): unknown[] {
  const [fields, template, ...rest] = args;
  if (!isFields(fields) || typeof template !== 'string') return args;
  const error = fields.error instanceof Error ? [fields.error] : [];
  const tail = [...rest, ...error];
  return [renderTemplate(template, fields, tail.length > 0), ...tail];
}

const FALLBACK: Record<Level, (...args: unknown[]) => void> = {
  error: (...args) => console.error(...consoleArgs(args)),
  warn: (...args) => console.warn(...consoleArgs(args)),
  info: (...args) => console.info(...consoleArgs(args)),
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
    (...args: unknown[]): void => {
      try {
        const l = target();
        const fn = l?.[level] as ((...a: unknown[]) => void) | undefined;
        if (l !== undefined && typeof fn === 'function') {
          fn.apply(l, args);
          return;
        }
      } catch {
        // fall through to the console fallback
      }
      try {
        FALLBACK[level](...args);
      } catch {
        // logging never throws
      }
    };
  return { error: write('error'), warn: write('warn'), info: write('info'), debug: write('debug') };
}
