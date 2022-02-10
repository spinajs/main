import { Injectable, Bootstrapper, DI } from "@spinajs/di";
import { Log } from "./log";
import CONFIGURATION_SCHEMA from "./schemas/log.configuration";

@Injectable(Bootstrapper)
export class LogBotstrapper extends Bootstrapper {
  public async bootstrap(): Promise<void> {
    DI.register(CONFIGURATION_SCHEMA).asValue("__configurationSchema__");

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
