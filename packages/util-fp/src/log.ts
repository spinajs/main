import { Log } from '@spinajs/log';
import { Effect } from 'effect';
import { Util as DI } from './di.js';

export namespace Util {
  export namespace Logger {
    export namespace FP {
      function callLog(logger: string, callback: (logger: Log) => void) {
        return DI.Di.FP.resolve(Log, [logger]).pipe(Effect.map((logger) => Effect.sync(() => callback(logger))));
      }

      export function trace(logger: string, message: string, ...args: any[]): void;
      export function trace(logger: string, err: Error, message: string, ...args: any[]): void;
      export function trace(logger: string, err: Error | string, message: string | any[], ...args: any[]) {
        return callLog(logger, (log) => {
          log.trace(err, message, ...args);
        });
      }

      export function debug(logger: string, message: string, ...args: any[]): void;
      export function debug(logger: string, err: Error, message: string, ...args: any[]): void;
      export function debug(logger: string, err: Error | string, message: string | any[], ...args: any[]) {
        return callLog(logger, (log) => {
          log.debug(err, message, ...args);
        });
      }

      export function info(logger: string, message: string, ...args: any[]): void;
      export function info(logger: string, err: Error, message: string, ...args: any[]): void;
      export function info(logger: string, err: Error | string, message: string | any[], ...args: any[]) {
        return callLog(logger, (log) => {
          log.info(err, message, ...args);
        });
      }

      export function warn(logger: string, message: string, ...args: any[]): void;
      export function warn(logger: string, err: Error, message: string, ...args: any[]): void;
      export function warn(logger: string, err: Error | string, message: string | any[], ...args: any[]) {
        return callLog(logger, (log) => {
          log.warn(err, message, ...args);
        });
      }

      export function error(logger: string, message: string, ...args: any[]): void;
      export function error(logger: string, err: Error, message: string, ...args: any[]): void;
      export function error(logger: string, err: Error | string, message: string | any[], ...args: any[]) {
        return callLog(logger, (log) => {
          log.error(err, message, ...args);
        });
      }

      export function fatal(logger: string, message: string, ...args: any[]): void;
      export function fatal(logger: string, err: Error, message: string, ...args: any[]): void;
      export function fatal(logger: string, err: Error | string, message: string | any[], ...args: any[]) {
        return callLog(logger, (log) => {
          log.fatal(err, message, ...args);
        });
      }

      export function security(logger: string, message: string, ...args: any[]): void;
      export function security(logger: string, err: Error, message: string, ...args: any[]): void;
      export function security(logger: string, err: Error | string, message: string | any[], ...args: any[]) {
        return callLog(logger, (log) => {
          log.security(err, message, ...args);
        });
      }

      export function success(logger: string, message: string, ...args: any[]): void;
      export function success(logger: string, err: Error, message: string, ...args: any[]): void;
      export function success(logger: string, err: Error | string, message: string | any[], ...args: any[]) {
        return callLog(logger, (log) => {
          log.success(err, message, ...args);
        });
      }
    }
  }
}
