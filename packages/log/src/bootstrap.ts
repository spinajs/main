import { Injectable, Bootstrapper, DI } from "@spinajs/di";
import { Log } from "./log";
import CONFIGURATION_SCHEMA from "./schemas/log.configuration";

@Injectable(Bootstrapper)
export class LogBotstrapper extends Bootstrapper {
  public bootstrap(): void {
    DI.register(CONFIGURATION_SCHEMA).asValue("__configurationSchema__");

    // check if we run tests,
    // hook for uncaughtException causes to not showing
    // mocha errors in console
    if (!process.env.TESTING) {
      process.on("uncaughtException", (err) => {
        const log = DI.resolve(Log, ["process"]);
        log.fatal(err, "Unhandled exception occured");
      });

      process.on("unhandledRejection", (reason, p) => {
        const log = DI.resolve(Log, ["process"]);
        log.fatal(reason as Error, "Unhandled rejection at Promise %s", p);
      });
    }
  }
}
