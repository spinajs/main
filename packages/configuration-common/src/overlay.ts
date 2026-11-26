import { SyncService } from '@spinajs/di';
import type { Configuration } from './definitions.js';

/**
 * Values that replace parts of the merged configuration for the current unit of work (a tenant). `Configuration.get`
 * asks the registered overlay for every read whose path it `covers`; with none registered it reads the merged tree only.
 */
export abstract class ConfigurationOverlay {
  /** Called once the configuration has loaded, and again after every reload: read the overlay's own settings here. */
  public abstract attach(configuration: Configuration): void;

  /** Whether a read of `path` can meet a value of this overlay: `path` is, lies below or lies above an overridable path. Called on every read. */
  public abstract covers(path: readonly string[]): boolean;

  /** The values of the current unit of work by dotted path; undefined or empty when it has none. Must not call `Configuration.get`. */
  public abstract values(): ReadonlyMap<string, unknown> | undefined;
}

/** Configuration values kept for one scope (`tenant:acme`), loaded before the reads that need them. */
export abstract class ScopedConfigurationSource extends SyncService {
  /** The values of `scope` by dotted path; undefined when this source holds none for it. Must not wait. */
  public abstract valuesOf(scope: string): ReadonlyMap<string, unknown> | undefined;
}
