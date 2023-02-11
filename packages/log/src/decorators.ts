/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { DI } from "@spinajs/di";
import { Log } from "./log.js";

/**
 * Creates ( if not exists ) new logger instance with given name and optional variables
 * @param name - name of logger
 * @param variables - optional log variables
 */
export function Logger(name: string, variables?: Record<string, unknown>) {
  return (target: any, key: string): any => {
    let logger: Log;

    // property getter
    const getter = () => {
      if (!logger) {
        const allLoggers = DI.get(Array.ofType(Log));
        const found = allLoggers.find((l) => l.Name === name);

        if (found) {
          logger = found;
        } else {
          logger = DI.resolve(Log, [name, variables]);
        }
      }
      return logger;
    };

    // Create new property with getter and setter
    Object.defineProperty(target, key, {
      get: getter,
      enumerable: false,
      configurable: false,
    });
  };
}
