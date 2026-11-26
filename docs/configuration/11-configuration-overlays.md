# Configuration overlays

An overlay answers some configuration reads differently per unit of work. `@spinajs/tenancy` registers one that answers a tenant's own values inside its tenant scope ([Configuration overrides per tenant](../tenancy/07-configuration-overrides.md)). Without a registered overlay `Configuration.get` reads the merged tree only.

## How it works

1. `FrameworkConfiguration.resolve()` resolves the class registered as `ConfigurationOverlay` once the configuration is loaded and checked, and calls its `attach(configuration)`. `load()` calls `attach` again after a reload.
2. For every read with a non-empty path, `get` asks `covers(path)`. A path that is not covered is read from the merged tree, as without an overlay.
3. For a covered path `get` asks `values()`: the values of the current unit of work by dotted path. With none, the merged tree answers.
4. Otherwise the most specific overridden path at or above the read answers; overrides below the read are written into a deep copy of the merged subtree, so `get('mail')` sees an override of `mail.from`. The merged tree itself never changes.
5. `set`, `merge` and the schema checks work on the merged tree only.

`Configuration.isOverlaid(path)` answers whether the registered overlay covers `path`. Code that copies a configuration value when it starts (a route's rate limit) reads it again per request when it is overlaid.

## Checking a value without writing it

```ts
const configuration = await DI.resolve(Configuration);
if (configuration instanceof FrameworkConfiguration) {
  configuration.check('mail.from', 'billing@acme.example');   // throws InvalidConfiguration when the schema of `mail` refuses it
}
```

`check(path, value)` runs the check `set()` runs before it writes, and writes nothing.

## Writing an overlay

```ts
@Injectable(ConfigurationOverlay)
export class RegionOverlay extends ConfigurationOverlay {
  private paths: string[][] = [];

  public attach(configuration: Configuration): void {
    this.paths = configuration.get<string[]>('region.overridable', []).map((p) => p.split('.'));
  }

  public covers(path: readonly string[]): boolean {
    return this.paths.some((p) => p.slice(0, path.length).every((s, i) => path[i] === s) || path.slice(0, p.length).every((s, i) => p[i] === s));
  }

  public values(): ReadonlyMap<string, unknown> | undefined {
    return currentRegion()?.overrides;
  }
}
```

`covers` runs on every read: keep it cheap. `values` must not call `Configuration.get`.

## Scoped configuration sources

`ScopedConfigurationSource` (a `SyncService`) holds configuration values per scope (`tenant:acme`) loaded ahead of the reads; an overlay reads them with `valuesOf(scope)`. `@spinajs/configuration-db-source` is one ([Database source](../configuration-db-source/01-database-source.md)).
