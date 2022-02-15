import {
  IColoredConsoleTargetOptions,
  LogLevelStrings,
  ILogEntry,
} from "@spinajs/log-common";
import { Injectable, Singleton } from "@spinajs/di";
import { LogTarget } from "./LogTarget";
import { LogLevel } from "..";
import * as colors from "colors/safe";
import { format } from "@spinajs/configuration";

export const DEFAULT_THEME = {
  security: ["red", "bgBrightWhite"],
  fatal: "red",
  error: "brightRed",
  warn: "yellow",
  success: "green",
  info: "white",
  debug: "gray",
  trace: "gray",
};

@Singleton()
@Injectable("ConsoleTarget")
export class ColoredConsoleTarget extends LogTarget<IColoredConsoleTargetOptions> {
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

  public resolve() {
    colors.setTheme(this.Options.theme ?? DEFAULT_THEME);
    super.resolve();
  }

  public async write(data: ILogEntry): Promise<void> {
    if (!this.Options.enabled) {
      return;
    }

    this.StdConsoleCallbackMap[data.Level](
      /**
       * we are safe to call, disable eslint
       */
      /* eslint-disable */
      (colors as any)[LogLevelStrings[data.Level]](
        format(data.Variables, this.Options.layout)
      )
    );
  }
}
