import { Configuration } from "@spinajs/configuration";
import { Injectable, Bootstrapper, DI } from "@spinajs/di";
import { Log, setLogContextProvider } from "@spinajs/log-common";
import { LogContext, scalarContext } from "./context.js";
import { wirePerfScope } from "./perf.js";
import CONFIGURATION_SCHEMA from "./schemas/log.configuration.js";

const uncaughtExceptionHandler = (err: Error) => {
  // if we have configuration resolved, we can assume that logger can read configuration
  // so log to default log
  // if not log to console
  if (DI.has(Configuration)) {
    const log = DI.resolve(Log, ["process"]);
    log.fatal(err, "Unhandled exception occured");
  } else {
    console.error("Unhandled exception: \n reason: " + err.message + " \n stack:" + err.stack);
  }
};

const unhandledRejection = (reason: Error, p: Promise<unknown>) => {
  // if we have configuration resolved, we can assume that logger can read configuration
  // so log to default log
  // if not log to console
  if (DI.has(Configuration)) {
    const log = DI.resolve(Log, ["process"]);
    log.fatal(reason as Error, "Unhandled rejection at Promise %s", p);
  } else {
    console.error("Unhandled rejection: \n reason: " + reason.message + " \n stack:" + reason.stack);
  }
};

// Guard so a double bootstrap ( eg. re-run in the same process ) does not
// register the beforeExit drain twice.
let beforeExitAttached = false;

@Injectable(Bootstrapper)
export class LogBotstrapper extends Bootstrapper {
  public bootstrap(): void {
    DI.register(CONFIGURATION_SCHEMA).asValue("__configurationSchema__");

    // Best-effort teardown drain: on a CLEAN process exit, force-flush every
    // logger's targets so buffered File / Loki / OTLP entries are written out.
    // beforeExit does NOT run on hard exits ( process.exit / signals / crashes ),
    // so this only catches clean drains. Node-only ( guard mirrors
    // internal-logger ); do not double-register.
    if (!beforeExitAttached && typeof process !== "undefined" && typeof process.on === "function") {
      beforeExitAttached = true;
      process.on("beforeExit", () => {
        void Log.flushAll();
      });
    }

    // Feed the ambient async-context store into every log entry ( merged at
    // lowest precedence by createLogMessageObject ). LogContext resolves the
    // same DI-singleton AsyncLocalStorage the http module runs per action, so
    // logs inherit requestId / realIp / ... for free.
    setLogContextProvider(() => scalarContext(LogContext.active()));

    // Wire the per-request perf accumulator onto the same async store.
    wirePerfScope();

    // check if we run tests,
    // hook for uncaughtException causes to not showing
    // mocha errors in console
    if (!process.env.TESTING) {
      process.removeListener("uncaughtException", uncaughtExceptionHandler);
      process.removeListener("unhandledRejection", unhandledRejection);

      process.on("uncaughtException", uncaughtExceptionHandler);
      process.on("unhandledRejection", unhandledRejection);
    }
  }
}
