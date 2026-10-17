import { DI } from "@spinajs/di";
import { Log } from "./index.js";
import { renderTemplate } from "./template.js";

/** The level methods of a {@link Log}, all four call forms included. */
export type LogWriter = Pick<Log, "trace" | "debug" | "info" | "success" | "warn" | "error" | "fatal" | "security">;

export type LogWriterLevel = keyof LogWriter;

const LEVELS: readonly LogWriterLevel[] = ["trace", "debug", "info", "success", "warn", "error", "fatal", "security"];

type Write = (...args: unknown[]) => void;

const isFields = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !(v instanceof Error) && !Array.isArray(v);

// The console has no layout: a fields-form call is rendered here as a Log would render it, and its error, which a layout prints, follows the line.
function consoleArgs(args: unknown[]): unknown[] {
  const [fields, template, ...rest] = args;
  if (!isFields(fields) || typeof template !== "string") {
    return args;
  }
  const error = fields.error instanceof Error ? [fields.error] : [];
  const tail = [...rest, ...error];
  return [renderTemplate(template, fields, tail.length > 0), ...tail];
}

const noop: Write = () => {};
const toConsole =
  (method: "info" | "warn" | "error"): Write =>
  (...args) =>
    console[method](...consoleArgs(args));

const CONSOLE: Record<LogWriterLevel, Write> = {
  trace: noop,
  debug: noop,
  info: toConsole("info"),
  success: toConsole("info"),
  warn: toConsole("warn"),
  error: toConsole("error"),
  fatal: toConsole("error"),
  security: toConsole("error"),
};

function writer(write: (level: LogWriterLevel) => Write): LogWriter {
  return Object.fromEntries(LEVELS.map((level) => [level, write(level)])) as unknown as LogWriter;
}

/** Writes to the console, for code that runs without a registered {@link Log}: trace and debug are dropped. Never throws. */
export const consoleLog: LogWriter = writer(
  (level) =>
    (...args) => {
      try {
        CONSOLE[level](...args);
      } catch {
        // logging never throws
      }
    },
);

const resolveRegistered = (name: string): Log | undefined => (DI.check(Log) ? (DI.resolve(Log, [name]) as Log) : undefined);

/**
 * A {@link LogWriter} for the logger `name` that falls back to {@link consoleLog} while no {@link Log} is registered,
 * and never throws. `resolveLog` is a test seam; production code passes only the name.
 */
export function optionalLog(name: string, resolveLog: (name: string) => Log | undefined = resolveRegistered): LogWriter {
  let log: Log | undefined;
  const target = (): Log | undefined => {
    // Not cached until a Log exists, so one registered later is picked up; never resolved when unregistered.
    if (log === undefined) {
      try {
        log = resolveLog(name);
      } catch {
        return undefined;
      }
    }
    return log;
  };
  return writer(
    (level) =>
      (...args) => {
        try {
          const l = target();
          const fn = l?.[level] as Write | undefined;
          if (l !== undefined && typeof fn === "function") {
            fn.apply(l, args);
            return;
          }
        } catch {
          // fall through to the console
        }
        (consoleLog[level] as Write)(...args);
      },
  );
}
