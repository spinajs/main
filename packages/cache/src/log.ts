import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log-common';

export interface CacheLog {
  warn(fields: Record<string, unknown>, message: string): void;
}

/** The logger 'cache' when a Log is registered, nothing otherwise; a failed write is dropped, so a cache failure never becomes an error through its log line. */
export const cacheLog: CacheLog = {
  warn(fields, message) {
    try {
      if (DI.check(Log)) DI.resolve(Log, ['cache']).warn(fields, message);
    } catch {
      return;
    }
  },
};
