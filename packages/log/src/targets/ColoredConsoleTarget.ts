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
const BASE_COLORS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const ANSI_CODES: Record<string, number> = { gray: 90, grey: 90, bgGray: 100, bgGrey: 100, bold: 1, dim: 2, italic: 3, underline: 4, inverse: 7 };
BASE_COLORS.forEach((c, i) => {
  const cap = c[0].toUpperCase() + c.slice(1);
  ANSI_CODES[c] = 30 + i;
  ANSI_CODES[`bright${cap}`] = 90 + i;
  ANSI_CODES[`bg${cap}`] = 40 + i;
  ANSI_CODES[`bgBright${cap}`] = 100 + i;
});

const style = (spec: string | string[]) => {
  const open = (Array.isArray(spec) ? spec : [spec])
    .filter((name) => ANSI_CODES[name] !== undefined)
    .map((name) => `\x1b[${ANSI_CODES[name]}m`)
    .join("");
  return (text: string) => `${open}${text}${ANSI_RESET}`;
};

export const DEFAULT_THEME: IColoredConsoleTargetOptions["theme"] = {
  security: ["yellow", "bgRed"],
  fatal: ["white", "bgRed"],
  error: "red",
  warn: "yellow",
  success: ["white", "bgGreen"],
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
    const theme = { ...DEFAULT_THEME, ...this.Options.theme };

    this.theme[LogLevel.Trace] = style(theme.trace);
    this.theme[LogLevel.Debug] = style(theme.debug);
    this.theme[LogLevel.Info] = style(theme.info);
    this.theme[LogLevel.Success] = style(theme.success);
    this.theme[LogLevel.Warn] = style(theme.warn);
    this.theme[LogLevel.Error] = style(theme.error);
    this.theme[LogLevel.Fatal] = style(theme.fatal);
    this.theme[LogLevel.Security] = style(theme.security);

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
