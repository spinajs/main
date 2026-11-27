import { InvalidOption } from '@spinajs/exceptions';
import type { TenantRecord, TenantRegistry } from './contracts.js';
import { TenantUnavailable } from './errors.js';
import { RESERVED_SEGMENTS } from './reserved.js';

const MAX_TENANTS = 10_000;

/**
 * Roots a tenant can never override: where data, files and logs go, who a caller is and what it may do, the audit
 * trail, the process's connections and wiring, and how tenancy and the configuration themselves work.
 */
export const CLOSED_CONFIGURATION_ROOTS: readonly string[] = [
  'tenancy',
  'db',
  'authz',
  'authn',
  'audit',
  'fs',
  'system',
  'process',
  'configuration',
  'configuration_db_source',
  'https',
  'logger',
  'telemetry',
  'otel',
  'cache',
];

export const OVERRIDABLE_PATH_PATTERN = '^[A-Za-z0-9_$-]+(\\.[A-Za-z0-9_$-]+)*$';

const OVERRIDABLE_PATH = new RegExp(OVERRIDABLE_PATH_PATTERN);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** `tenancy.config.overridable` as segments; throws InvalidOption for a malformed path or one under a closed root. */
export function overridablePaths(listed: unknown): string[][] {
  if (listed === undefined || listed === null) return [];
  if (!Array.isArray(listed)) throw new InvalidOption('tenancy.config.overridable is a list of configuration paths');
  return listed.map((path: unknown, index) => {
    if (typeof path !== 'string' || !OVERRIDABLE_PATH.test(path)) {
      throw new InvalidOption(`tenancy.config.overridable[${index}] is not a dotted configuration path: ${JSON.stringify(path)}`);
    }
    const segments = path.split('.');
    const reserved = segments.find((segment) => RESERVED_SEGMENTS.has(segment));
    if (reserved !== undefined) throw new InvalidOption(`tenancy.config.overridable[${index}] ${path}: '${reserved}' is not a configuration key`);
    if (CLOSED_CONFIGURATION_ROOTS.includes(segments[0])) {
      throw new InvalidOption(`tenancy.config.overridable[${index}] ${path}: a tenant cannot override ${segments[0]}.*`);
    }
    return segments;
  });
}

function valueAt(source: Readonly<Record<string, unknown>>, segments: readonly string[]): { value: unknown } | undefined {
  let current: unknown = source;
  for (const segment of segments) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return { value: current };
}

/**
 * The overrides `settings` holds for the overridable `paths`, by dotted path. A value is found in the configuration's
 * shape (`{ mail: { from } }`) or under the dotted key itself (`{ 'mail.from': ... }`), which wins.
 */
export function overridesOf(settings: Readonly<Record<string, unknown>>, paths: readonly (readonly string[])[]): Map<string, unknown> {
  const overrides = new Map<string, unknown>();
  for (const path of paths) {
    const key = path.join('.');
    const found = Object.hasOwn(settings, key) ? { value: settings[key] } : valueAt(settings, path);
    if (found !== undefined) overrides.set(key, found.value);
  }
  return overrides;
}

interface Loaded {
  readonly settings: Readonly<Record<string, unknown>>;
  readonly at: number;
}

/**
 * The settings of the tenants this process admitted, for synchronous reads: `Configuration.get` cannot wait. An entry
 * older than `ttlMs()` is answered and read again in the background; with `ttlMs()` 0 only an admission reads it again.
 */
export class TenantSettings {
  private readonly loaded = new Map<string, Loaded>();

  private readonly reading = new Map<string, Promise<Readonly<Record<string, unknown>>>>();

  constructor(
    private readonly registry: TenantRegistry,
    private readonly ttlMs: () => number,
    private readonly onRefreshFailed: (tenant: string, error: unknown) => void,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The settings last loaded for `tenant`; undefined when this process has not loaded them. */
  public settingsOf(tenant: string): Readonly<Record<string, unknown>> | undefined {
    const hit = this.loaded.get(tenant);
    if (hit === undefined) return undefined;
    const ttl = this.ttlMs();
    if (ttl > 0 && this.now() - hit.at >= ttl && !this.reading.has(tenant)) {
      // Stamped when the refresh starts: during an outage every stale read would otherwise read the registry and warn once more.
      this.loaded.set(tenant, { settings: hit.settings, at: this.now() });
      void this.load(tenant).catch((error: unknown) => this.onRefreshFailed(tenant, error));
    }
    return hit.settings;
  }

  public remember(record: TenantRecord): void {
    // A Map iterates in insertion order: the first key is the entry loaded longest ago.
    this.loaded.delete(record.id);
    if (this.loaded.size >= MAX_TENANTS) {
      const oldest = this.loaded.keys().next();
      if (oldest.done !== true) this.loaded.delete(oldest.value);
    }
    this.loaded.set(record.id, { settings: record.settings, at: this.now() });
  }

  /** Reads the tenant from the registry, in any state, and remembers its settings; a read of the tenant already running is shared. */
  public load(tenant: string): Promise<Readonly<Record<string, unknown>>> {
    const running = this.reading.get(tenant);
    if (running !== undefined) return running;
    const read = this.read(tenant).finally(() => this.reading.delete(tenant));
    this.reading.set(tenant, read);
    return read;
  }

  private async read(tenant: string): Promise<Readonly<Record<string, unknown>>> {
    const record = await this.registry.get(tenant);
    if (record === undefined) {
      this.loaded.delete(tenant);
      throw new TenantUnavailable('unknown', `no tenant "${tenant}"`);
    }
    this.remember(record);
    return record.settings;
  }
}
