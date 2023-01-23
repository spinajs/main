import { Configuration } from "@spinajs/configuration";
import { Injectable, Bootstrapper, DI } from "@spinajs/di";
import { Log } from "./log.js";
import CONFIGURATION_SCHEMA from "./schemas/log.configuration.js";

@Injectable(Bootstrapper)
export class LogBotstrapper extends Bootstrapper {
  public bootstrap(): void {
    DI.register(CONFIGURATION_SCHEMA).asValue("__configurationSchema__");

    // check if we run tests,
    // hook for uncaughtException causes to not showing
    // mocha errors in console
    if (!process.env.TESTING) {
      process.on("uncaughtException", (err) => {
        // if we have configuration resolved, we can assume that logger can read configuration
        // so log to default log
        // if not log to console
        if (DI.has(Configuration)) {
          const log = DI.resolve(Log, ["process"]);
          log.fatal(err, "Unhandled exception occured");
        } else {
          console.error("Unhandled exception occured, reason:" + JSON.stringify(err));
        }
      });

      process.on("unhandledRejection", (reason, p) => {
        // if we have configuration resolved, we can assume that logger can read configuration
        // so log to default log
        // if not log to console
        if (DI.has(Configuration)) {
          const log = DI.resolve(Log, ["process"]);
          log.fatal(reason as Error, "Unhandled rejection at Promise %s", p);
        } else {
          console.error("Unhandled rejection at Promise %s, reason: " + JSON.stringify(reason));
        }
      });
    }
  }
}
