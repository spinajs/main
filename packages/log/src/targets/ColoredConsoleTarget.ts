import {
  IColoredConsoleTargetOptions,
  LogLevelStrings,
  ILogTargetData
} from "./../types";
import { IContainer, Injectable, Singleton } from "@spinajs/di";
import { LogTarget } from "./LogTarget";
import { LogLevel } from "..";

// tslint:disable-next-line
const colors = require("colors/safe");

export const DEFAULT_THEME = {
  security: ["red", "bgBrightWhite"],
  fatal: "red",
  error: "brightRed",
  warn: "yellow",
  success: "green",
  info: "white",
  debug: "gray",
  trace: "gray"
};

@Singleton()
@Injectable("ConsoleTarget")
export class ColoredConsoleTarget extends LogTarget<
  IColoredConsoleTargetOptions
> {
  protected StdConsoleCallbackMap = {
    [LogLevel.Error]: console.error,
    [LogLevel.Fatal]: console.error,
    [LogLevel.Security]: console.error,

    [LogLevel.Info]: console.log,
    [LogLevel.Success]: console.log,

    [LogLevel.Trace]: console.debug,
    [LogLevel.Debug]: console.debug,

    [LogLevel.Warn]: console.warn
  };

  public resolve(_: IContainer) {
    colors.setTheme(this.Options.theme ?? DEFAULT_THEME);
    super.resolve(_);
  }

  public async write(data: ILogTargetData): Promise<void> {
    if (!this.Options.enabled) {
      return;
    }

    this.StdConsoleCallbackMap[data.Level](
      (colors as any)[LogLevelStrings[data.Level]](
        this.format(data.Variables, this.Options.layout)
      )
    );
  }
}
