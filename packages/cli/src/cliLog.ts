import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log-common';
import { InternalLoggerProxy } from '@spinajs/internal-logger';

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
