import {
  IColoredConsoleTargetOptions,
  ILogEntry,
  LogLevel,
  LogTarget,
} from "@spinajs/log-common";
import { Injectable, Singleton } from "@spinajs/di";
import { format } from "@spinajs/configuration-common";

/**
 * Browser counterpart of ColoredConsoleTarget: same "ConsoleTarget" DI name so
 * existing logger configs resolve it unchanged, but no chalk (Node-only) — the
 * browser devtools console provides its own styling per console method.
 *
 * Registered ONLY by the browser entry (index.browser.ts); never add it to
 * targets/index.ts or it would fight ColoredConsoleTarget over "ConsoleTarget"
 * on Node.
 */
@Singleton()
@Injectable("ConsoleTarget")
export class BrowserConsoleTarget extends LogTarget<IColoredConsoleTargetOptions> {
  protected StdConsoleCallbackMap = {
    [LogLevel.Error]: console.error,
    [LogLevel.Fatal]: console.error,
    [LogLevel.Security]: console.error,

    [LogLevel.Info]: console.log,
    [LogLevel.Success]: console.log,

    [LogLevel.Trace]: console.debug,
    [LogLevel.Debug]: console.debug,

    [LogLevel.Warn]: console.warn,
  };

  public async write(data: ILogEntry): Promise<void> {
    if (!this.Options.enabled) {
      return;
    }

    this.StdConsoleCallbackMap[data.Level](
      format(data.Variables, this.Options.layout)
    );
  }
}
