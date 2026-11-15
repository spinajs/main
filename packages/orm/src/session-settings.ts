import type { OrmDriver } from './driver.js';

export type SessionSettings = Readonly<Record<string, string>>;

/**
 * Transaction-local settings for the statements of the current async path. `OrmDriver` applies them right after BEGIN
 * through the dialect's `SessionSettingsQueryCompiler`, and runs a statement issued outside a transaction in one of its
 * own. A dialect without them throws `NotSupported` instead of dropping them. Several providers merge, later wins;
 * `undefined` sets nothing. A provider whose own work runs queries must answer `undefined` for those.
 */
export abstract class ConnectionSessionSettings {
  abstract settings(driver: OrmDriver): Promise<SessionSettings | undefined>;
}
