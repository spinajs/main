import {
  IColoredConsoleTargetOptions,
  ILogEntry,
  LogTarget,
} from "@spinajs/log-common";
import { Injectable, Singleton } from "@spinajs/di";
import { LogLevel } from "./../index.js";
import chalk from "chalk";
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
  protected theme: any[] = [];

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

  public async resolve() {
    this.theme[LogLevel.Trace] = chalk.gray;
    this.theme[LogLevel.Debug] = chalk.gray;
    this.theme[LogLevel.Info] = chalk.white;
    this.theme[LogLevel.Success] = chalk.white.bgGreen;
    this.theme[LogLevel.Warn] = chalk.yellow;
    this.theme[LogLevel.Error] = chalk.red;
    this.theme[LogLevel.Fatal] = chalk.white.bgRed;
    this.theme[LogLevel.Security] = chalk.yellow.bgRed;

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
      (this.theme as any)[data.Level](
        format(data.Variables, this.Options.layout)
      )
    );
  }
}
