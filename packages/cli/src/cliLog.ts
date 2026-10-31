import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log-common';
import { InternalLoggerProxy } from '@spinajs/internal-logger';
import { CommanderError } from 'commander';

const FLUSH_LIMIT_MS = 2000;

/**
 * The full framework logger ( @spinajs/log ) cannot be imported by the cli
 * entry point: its tsconfig project sits in a reference cycle with this
 * package ( cli -> log -> fs -> cli ), so only the abstract `Log` from
 * log-common is visible here. When nothing loaded so far has registered an
 * implementation, resolving the abstract class yields an instance with no log
 * methods at all — `log.success is not a function`. Fall back to
 * InternalLoggerProxy — the framework's pre-logger proxy — instead of crashing
 * before the commands ( which do import @spinajs/log and register it as an
 * import side effect ) get a chance to load.
 *
 * @param isRegistered - registration probe, replaceable in tests
 */
export function resolveCliLog(isRegistered: () => boolean = () => DI.check(Log)): Log {
  return isRegistered() ? DI.resolve(Log, ['CLI']) : DI.resolve(InternalLoggerProxy, ['CLI']);
}

/** The message alone: a stack or a `cause` would print what an error keeps private on purpose, like an OrmException's driver error. */
export function fatalMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Tells why the process is about to exit. Stderr always gets the message, because the configured targets may be a
 * file or nothing a terminal shows; they get it too, and are flushed, since `process.exit` would drop what they hold.
 * Commander's own errors already went out through the `writeErr` of `Cli`.
 */
export async function reportFatal(err: unknown, write: (line: string) => void = (line) => console.error(line)): Promise<void> {
  if (!(err instanceof CommanderError)) {
    write(fatalMessage(err));
  }
  if (!DI.check(Log)) {
    return;
  }
  try {
    if (!(err instanceof CommanderError)) {
      resolveCliLog().error(fatalMessage(err));
    }
    await Promise.race([Log.flushAll(), new Promise((resolve) => setTimeout(resolve, FLUSH_LIMIT_MS))]);
  } catch {
    // The failure may be the logger's own configuration; stderr has the message.
  }
}
