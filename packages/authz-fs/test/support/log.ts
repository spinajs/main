import { DI } from '@spinajs/di';
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

/** Registers the quiet Log in root unless a Log is registered; returns the undo. */
export function installQuietLog(): () => void {
  if (DI.RootContainer.hasRegistered(Log)) return () => undefined;
  return testHost.registerInRoot(Log, ((_container: unknown, name: string) => quietLog(name)) as never);
}
