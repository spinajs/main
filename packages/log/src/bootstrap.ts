import { FileTarget } from "./targets/FileTarget";
import { IFileTargetOptions } from "@spinajs/log-common";
import { Injectable, Bootstrapper, DI, IContainer } from "@spinajs/di";
import { Log } from "./log";
import CONFIGURATION_SCHEMA from "./schemas/log.configuration";

@Injectable(Bootstrapper)
export class LogBotstrapper extends Bootstrapper {
  public bootstrap(): void {
    DI.register(CONFIGURATION_SCHEMA).asValue("__configurationSchema__");

    // register factory for file target,
    // becouse we want to create target
    // only one per target not one for every logger
    DI.register((container: IContainer, options: IFileTargetOptions) => {
      const fileTargets = container.get(Array.ofType("__log_file_targets__"));
      let target = fileTargets.find((t: FileTarget) => t.Options.name === options.name) as FileTarget;

      if (!target) {
        target = container.resolve<FileTarget>("__file_target_implementation__",[options]);
        container.register(target).asValue("__log_file_targets__");

        return target;
      }

      return target;
    }).as("FileTarget");

    DI.register(FileTarget).as("__file_target_implementation__");

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
