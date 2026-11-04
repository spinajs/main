import type { OrmDriver } from './driver.js';

/**
 * Transaction-local settings for the statements of the current async path (`set_config(name, value, true)` on
 * Postgres): a driver that supports them applies them right after BEGIN, and wraps a statement that runs outside a
 * transaction in one so the settings never outlive it on a pooled connection. Several providers merge, later wins.
 * `undefined` sets nothing. A provider whose own work runs queries must answer `undefined` for those.
 */
export abstract class ConnectionSessionSettings {
  abstract settings(driver: OrmDriver): Promise<Readonly<Record<string, string>> | undefined>;
}
