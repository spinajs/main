# Configuration overlays

An overlay answers some configuration reads differently per unit of work, for example a tenant's own values inside its tenant scope. Without a registered overlay `Configuration.get` reads the merged tree only.

Nothing in `@spinajs/configuration` limits what an overlay covers: `get` asks it about every path, `authn.*`, `db.*` and `process.*` included, so its own `covers` must refuse connection settings, secrets and security settings, because whatever writes its values can change every path it covers.

## How it works

1. `FrameworkConfiguration.resolve()` resolves the class registered as `ConfigurationOverlay` once the configuration is loaded and checked, and calls its `attach(configuration)`. `load()` calls `attach` again after a reload.
2. For every read with a non-empty path, `get` asks `covers(path)`. A path that is not covered is read from the merged tree, as without an overlay. The empty path is never overlaid.
3. For a covered path `get` asks `values()`: the values of the current unit of work by dotted path. `undefined` (or an empty map) means the unit of work has no values of its own, and the merged tree answers. An overlay fails closed: when the unit of work should have values that are not loaded yet (before the overlay's first load), `values()` throws, and so does the read; while it refreshes them, it keeps answering the values it has.
4. Otherwise the most specific overridden path at or above the read answers. Overrides below the read are laid into it, so `get('mail')` sees an override of `mail.from`: only the objects on the way from the read down to each override are copied, and everything beside them is the merged tree's own value, so a class instance stays the same instance and a lazy variable stays unresolved. The merged tree never changes. Of two nested overrides (`mail.smtp` and `mail.smtp.port`) the more specific wins.
5. An override of an array replaces it as a whole. A key that names one element (`limits.hosts.1`) sets that index in a copy of the array, so `get('limits.hosts')` and `get('limits.hosts.1')` agree.
6. `set`, `merge` and the schema checks work on the merged tree only.

## Reads that copy a value once

`Configuration.isOverlaid(path)` answers whether the registered overlay covers `path`. A `@Config` property is a getter that calls `get` on every read, so it follows the unit of work. These read their path once, when the instance is built or the call runs, and keep the value of the unit of work they ran in:

- `@AutoinjectService`, `@AutoinjectNamedService` and `@AutoinjectNamedServices`: the service name at the path is read when the instance is injected, and a singleton keeps the service it got.
- `resolveNamedService()` and `resolveNamedServices()`: the path is read when they are called.
- reads in a constructor or in `resolve()`, and any value a service keeps in a field.

Code that copies a value this way asks `isOverlaid(path)` and reads it again per unit of work, or refuses an overlaid path.

## Checking a value without writing it

```ts
const configuration = await DI.resolve(Configuration);
if (configuration instanceof FrameworkConfiguration) {
  const enabled = configuration.check('mail.enabled', 'false');   // false: the boolean the schema of `mail` accepted
}
```

`check(path, value)` runs the check `set()` runs before it writes, writes nothing, and returns the value as the schemas accept it: coerced, with defaults filled and undeclared keys removed (a copy of `value` where no schema applies). It throws `InvalidConfiguration`, naming the key, when the schema refuses the value, and `InvalidOperation` while the configuration loads, when the schemas cannot judge it. An overlay stores and serves the value `check` returned, never its input: `'false'` passes the check of a boolean, but served as is it is a truthy string.

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
    // filled from what FrameworkConfiguration.check() returned for each value
    return currentRegion()?.overrides;
  }
}
```

`covers` runs on every read: keep it cheap. `values` must not call `Configuration.get`.

## Scoped configuration sources

`ScopedConfigurationSource` (a `SyncService`) holds configuration values per scope (`tenant:acme`) loaded ahead of the reads; an overlay reads them with `valuesOf(scope)`.
