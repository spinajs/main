import {
  IColoredConsoleTargetOptions,
  ILogEntry,
  LogTarget,
} from "@spinajs/log-common";
import { Injectable, Singleton } from "@spinajs/di";
import { LogLevel } from "./../index.js";
import { format } from "@spinajs/configuration";

/**
 * Minimal, dependency-free ANSI colour helpers ( replaces chalk ).
 * Console target is Node-only, so raw escape codes are fine.
 */
const ANSI_RESET = "\x1b[0m";
const ansi = (open: string) => (text: string) => `${open}${text}${ANSI_RESET}`;
const gray = ansi("\x1b[90m");
const white = ansi("\x1b[37m");
const whiteBgGreen = ansi("\x1b[37m\x1b[42m");
const yellow = ansi("\x1b[33m");
const red = ansi("\x1b[31m");
const whiteBgRed = ansi("\x1b[37m\x1b[41m");
const yellowBgRed = ansi("\x1b[33m\x1b[41m");

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
    this.theme[LogLevel.Trace] = gray;
    this.theme[LogLevel.Debug] = gray;
    this.theme[LogLevel.Info] = white;
    this.theme[LogLevel.Success] = whiteBgGreen;
    this.theme[LogLevel.Warn] = yellow;
    this.theme[LogLevel.Error] = red;
    this.theme[LogLevel.Fatal] = whiteBgRed;
    this.theme[LogLevel.Security] = yellowBgRed;

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
