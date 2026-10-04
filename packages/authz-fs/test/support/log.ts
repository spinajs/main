import { Log } from '@spinajs/log-common';
import { testHost } from '@spinajs/authz-testing';

export interface LogLine {
  readonly logger: string;
  readonly level: string;
  readonly message: string;
}

/** What the quiet Log received since the last clear. */
export const logLines: LogLine[] = [];

// fs providers and fsService log through @Logger, which needs some Log registered; no app logger runs in these tests.
function quietLog(name: string): Log {
  const target = { Name: name };
  return new Proxy(target, {
    get(t, key) {
      if (key in t) return t[key as keyof typeof t];
      if (typeof key !== 'string' || key === 'then') return undefined;
      return (...args: unknown[]) => {
        const message = args.find((a) => typeof a === 'string');
        logLines.push({ logger: name, level: key, message: typeof message === 'string' ? message : '' });
      };
    },
  }) as unknown as Log;
}

const quietFactory = ((_container: unknown, name: string) => quietLog(name)) as never;
let users = 0;
let unregister: (() => void) | undefined;

/**
 * Registers the quiet Log in root, also over another Log (`@spinajs/orm-sqlite` imports the console one of
 * `@spinajs/log`); returns the undo. Calls nest: the last undo removes it.
 */
export function installQuietLog(): () => void {
  if (users++ === 0) unregister = testHost.registerInRoot(Log, quietFactory);
  let undone = false;
  return () => {
    if (undone) return;
    undone = true;
    if (--users === 0) {
      unregister?.();
      unregister = undefined;
    }
  };
}
