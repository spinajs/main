import { Autoinject, Container, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { ConfigurationOverlay, FrameworkConfiguration } from '@spinajs/configuration';
import type { Configuration } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log-common';
import { TenantSettingsUnavailable } from './errors.js';
import { checkTenantValue } from './reserved.js';
import { tenantScope } from './scope.js';
import { TenancyServices } from './services.js';
import { CLOSED_CONFIGURATION_ROOTS, overridablePaths, overridesOf } from './settings.js';

const MAX_TENANTS = 10_000;

const MAX_REPORTED_PATHS = 20;

const isPrefix = (a: readonly string[], b: readonly string[]): boolean => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
};

const startsWith = (path: readonly string[], prefix: readonly string[]): boolean => prefix.length <= path.length && isPrefix(path, prefix);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Paths of `settings` that look like configuration (a closed root, or a root the configuration has) and that no overridable path serves. */
function unservedPaths(settings: Readonly<Record<string, unknown>>, paths: readonly (readonly string[])[], configured: (root: string) => boolean): string[] {
  const found: string[] = [];
  const visit = (value: unknown, at: string[]): void => {
    if (paths.some((p) => startsWith(at, p))) return;
    if (!isRecord(value) || !paths.some((p) => startsWith(p, at))) {
      found.push(at.join('.'));
      return;
    }
    for (const [key, child] of Object.entries(value)) visit(child, [...at, key]);
  };
  for (const [key, value] of Object.entries(settings)) {
    const at = key.split('.');
    if (CLOSED_CONFIGURATION_ROOTS.includes(at[0]) || configured(at[0])) visit(value, at);
  }
  return found;
}

function keep<V>(map: Map<string, V>, key: string, value: V): void {
  // A Map iterates in insertion order: the first key is the entry kept longest ago.
  map.delete(key);
  if (map.size >= MAX_TENANTS) {
    const oldest = map.keys().next();
    if (oldest.done !== true) map.delete(oldest.value);
  }
  map.set(key, value);
}

interface Checked {
  readonly from: readonly object[];
  readonly values: ReadonlyMap<string, unknown>;
}

interface Reported {
  readonly settings: object;
  readonly paths: string;
}

/**
 * Inside a tenant scope, answers the tenant's settings for the paths listed in `tenancy.config.overridable`. With no
 * scope, and across all tenants, it answers nothing and the shared configuration applies.
 */
@Injectable(ConfigurationOverlay)
export class TenantConfigurationOverlay extends ConfigurationOverlay {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Logger('tenancy')
  protected Log!: Log;

  protected paths: string[][] = [];

  private roots = new Set<string>();

  private configuration: FrameworkConfiguration | undefined;

  private checked = new Map<string, Checked>();

  // By tenant: a registry refresh hands out a new settings object with the same paths, which must not warn again.
  private reported = new Map<string, Reported>();

  public attach(configuration: Configuration): void {
    if (!(configuration instanceof FrameworkConfiguration)) {
      throw new InvalidOperation('TenantConfigurationOverlay serves only values FrameworkConfiguration.check accepted, and the registered Configuration is another class');
    }
    this.paths = overridablePaths(configuration.get<unknown>('tenancy.config.overridable'));
    this.roots = new Set(this.paths.map((path) => path[0]));
    this.configuration = configuration;
    this.checked = new Map();
    this.reported = new Map();
  }

  public covers(path: readonly string[]): boolean {
    return this.roots.has(path[0]) && this.paths.some((p) => isPrefix(p, path));
  }

  public values(): ReadonlyMap<string, unknown> | undefined {
    const scope = tenantScope();
    if (scope?.kind !== 'tenant') return undefined;
    const tenant = scope.tenant.id;
    const services: TenancyServices | null | undefined = this.Container.get(TenancyServices);
    const settings = services?.settings.settingsOf(tenant);
    if (settings === undefined) {
      throw new TenantSettingsUnavailable(`the settings of tenant "${tenant}" are not loaded in this process: enter it through an entry point that admits it, or await loadTenantSettings('${tenant}') first`);
    }
    const values = this.checkedValues(tenant, [overridesOf(settings, this.paths)], [settings]);
    this.reportUnserved(tenant, settings);
    return values;
  }

  /**
   * The values of `layers` (the weakest first) as the configuration schema accepted them, kept per tenant until one of
   * `from` is another object.
   */
  protected checkedValues(tenant: string, layers: readonly ReadonlyMap<string, unknown>[], from: readonly object[]): ReadonlyMap<string, unknown> {
    const known = this.checked.get(tenant);
    if (known !== undefined && known.from.length === from.length && known.from.every((f, i) => f === from[i])) return known.values;

    let values: Map<string, unknown>;
    try {
      values = this.checkLayers(tenant, layers);
    } catch (error) {
      if (!(error instanceof InvalidOperation)) throw error;
      // The configuration is loading: its schemas cannot judge now, which is no verdict, so nothing is kept.
      if (known !== undefined) return known.values;
      throw new TenantSettingsUnavailable(`the settings of tenant "${tenant}" are checked once the configuration has loaded; read again then`);
    }
    keep(this.checked, tenant, { from, values });
    return values;
  }

  private checkLayers(tenant: string, layers: readonly ReadonlyMap<string, unknown>[]): Map<string, unknown> {
    const values = new Map<string, unknown>();
    for (const layer of layers) {
      for (const [path, value] of layer) {
        const accepted = this.checkedValue(tenant, path, value);
        if (accepted !== undefined) values.set(path, accepted.value);
      }
    }
    return values;
  }

  // The value check() returned (coerced, undeclared keys removed), never `value`; undefined when it is refused.
  private checkedValue(tenant: string, path: string, value: unknown): { value: unknown } | undefined {
    if (this.configuration === undefined) return undefined;
    try {
      return { value: checkTenantValue(this.configuration, path, value) };
    } catch (error) {
      if (error instanceof InvalidOperation) throw error;
      this.Log.warn({ tenant, path, error }, 'Tenant ${tenant}: its value of ${path} is refused (the configuration schema, or a reserved key); the shared value applies');
      return undefined;
    }
  }

  private reportUnserved(tenant: string, settings: Readonly<Record<string, unknown>>): void {
    const last = this.reported.get(tenant);
    if (last?.settings === settings || this.configuration === undefined) return;
    const root = this.configuration.RootConfig;
    const found = unservedPaths(settings, this.paths, (key) => Object.hasOwn(root, key));
    const named = found.slice(0, MAX_REPORTED_PATHS).join(', ');
    const paths = found.length > MAX_REPORTED_PATHS ? `${named} and ${found.length - MAX_REPORTED_PATHS} more` : named;
    keep(this.reported, tenant, { settings, paths });
    if (paths !== '' && paths !== last?.paths) {
      this.Log.warn({ tenant, paths }, 'Tenant ${tenant}: its settings hold ${paths}, which tenancy.config.overridable does not list; they are never laid over the configuration');
    }
  }
}
