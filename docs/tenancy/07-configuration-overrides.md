# Configuration overrides per tenant

A tenant can have its own value for the configuration paths the application lists in `tenancy.config.overridable`: a sender address, a default locale, a limit. Inside the tenant's scope `Configuration.get`, and every `@Config` property, answers the tenant's value; every other path, and every read outside a tenant, answers the shared configuration.

```ts
// config
{ tenancy: { config: { overridable: ['mail.from', 'limits.exports'] } }, mail: { from: 'noreply@app.example' } }

// the tenant's settings mirror the configuration's shape; a dotted key works too
{ id: 'acme', settings: { mail: { from: 'billing@acme.example' }, 'limits.exports': 50, plan: 'pro' } }

await runInTenant('acme', async () => configuration.get('mail.from'));   // 'billing@acme.example'
configuration.get('mail.from');                                          // 'noreply@app.example'
```

## What a tenant can and cannot override

- A tenant overrides **only the paths the application lists** in `tenancy.config.overridable`, and the paths below them. Nothing a tenant stores can add a path to that list.
- A tenant **never** overrides a path under `tenancy`, `db`, `authz`, `authn`, `audit`, `fs`, `system`, `process`, `configuration`, `configuration_db_source`, `https`, `logger`, `telemetry`, `otel` or `cache`: they decide where data, files and logs go, who a caller is and what it may do, and how the process is wired. A listed path under one of them fails the boot with `InvalidOption`, naming the entry and the root. So does a malformed path, a path with a segment `__proto__`, `constructor` or `prototype`, and a key under `tenancy.config` other than `overridable` (a misspelt `overrideable` would leave every path closed).
- Every other root is the application's decision. **The allow list is the control; the closed roots are only a backstop and do not cover every secret.** Roots that hold secrets or security switches stay open because a tenant may legitimately override other keys under them: `http` (the cookie secret, `trustProxy`, CORS), `email` (SMTP connections and passwords), `teams` (the invitation secret), `studio`, `upload`, `queue` (transport connections) and `tracing`. Whoever can write a tenant's settings can set every listed path for that tenant: never list a secret, a credential, or a trust or security switch, and list leaf paths, not roots.
- A listed child does not open its parent: with `mail.from` listed, a tenant's `mail.retries` is not read, and a read of `mail` inside the tenant gets the shared `mail` with the tenant's `from` laid in. List leaf paths to override single keys.
- A listed array is replaced whole by the tenant's array.

## How it works

1. Importing `@spinajs/tenancy` registers `TenantConfigurationOverlay` as the `ConfigurationOverlay` ([Configuration overlays](../configuration/11-configuration-overlays.md)). It reads `tenancy.config.overridable` when the configuration loads and after every reload.
2. `admitTenant()` remembers the admitted tenant's `settings` in this process. The HTTP, socket and queue entry points admit (the scheduler, workflow and CLI do not admit a tenant yet: code there loads the settings itself, see below), and `forEachTenant` remembers the settings of each tenant it visits, so code that runs there finds them.
3. Inside a tenant scope, a read of an overridable path, of a path below one or of a path above one gets the tenant's values laid over the shared configuration. Outside any tenant (boot code, a background job, a CLI command) and across all tenants, every read answers the shared configuration.
4. A value at a path the configuration schema declares is checked against it before it is used, and the value read is the one the schema accepted ([Checking a value without writing it](../configuration/11-configuration-overlays.md#checking-a-value-without-writing-it)): a stored `'false'` at a boolean path is read as `false`, a number stored as text as the number. **A path no schema declares (or a key an open schema does not name) is served as stored (a copy): list only paths the configuration schema declares.** A value the schema refuses (the schema changed since the value was written), or one that holds a `__proto__`, `constructor` or `prototype` key at any depth, is dropped for that path alone, with one warning on the `tenancy` logger; the shared value applies there and the tenant keeps its other values. While the configuration reloads the schemas cannot judge: a tenant keeps the values checked before, and a tenant checked for the first time then throws `TenantSettingsUnavailable` until the reload ends.
5. A stored value at a path that is not listed (a row written by SQL, or before the path left the list or a root was closed) is never served, and no read throws for it. When a settings key lies under a closed root or under a root the configuration has, the `tenancy` logger warns once, naming the paths. Other keys are free-form settings: they are kept on the tenant record and never laid over the configuration.
6. Settings loaded longer ago than `tenancy.registryCacheMs` are answered and read again in the background. A tenant changed by another process is served within `tenancy.registryCacheMs` and one registry read. When that read fails, the last settings stay, the `tenancy` logger warns once, and the next read of the registry waits another `tenancy.registryCacheMs`. A process keeps the settings of at most 10,000 tenants: past that, the tenant loaded longest ago is dropped, and a read of an overridable path in it throws `TenantSettingsUnavailable` until its next admission or `loadTenantSettings`.

## Code that enters a tenant without an entry point

A script or a test that enters a tenant with `runInTenant` alone has not admitted it. A read of an overridable path then throws `TenantSettingsUnavailable`; load the settings first:

```ts
await loadTenantSettings('acme');
await runInTenant('acme', async () => sendInvoices());
```

`loadTenantSettings` loads a tenant in any state; only a tenant the registry does not know throws `TenantUnavailable`.

## Writing settings

`checkTenantSettings(settings)` throws `InvalidConfiguration` when a value at an overridable path does not pass the schema or holds a `__proto__`, `constructor` or `prototype` key at any depth (a value the overlay would drop), and `InvalidOperation` while the configuration loads. Call it before a tenant's settings are written. After writing settings by other means, invalidate the registry cache (`(await tenantRegistry()).invalidate(id)`) and call `loadTenantSettings(id)`.

## Values copied at boot

A value read once never sees a tenant's override. `@AutoinjectService`, `@AutoinjectNamedService(s)`, `resolveNamedService(s)` and a `ConfigVar` resolved when its owner is built read their path once ([Reads that copy a value once](../configuration/11-configuration-overlays.md#reads-that-copy-a-value-once)). Read overridable values through `Configuration.get` or `@Config` at the moment they are used.

A service that copies an overridable value in its constructor or in `resolve()` keeps the value of the scope that resolved it first. Resolved for the first time inside tenant `acme`'s request, a singleton keeps `acme`'s value and serves it to every other tenant and to code with no tenant. Before a path is listed in `tenancy.config.overridable`, check that no service copies it. A service that must copy a value asks `configuration.isOverlaid(path)` when it starts and refuses an overlaid path.

| Value | Read | Per tenant |
| --- | --- | --- |
| `@Config` properties | on every access | yes |
| `Configuration.get` | on every call | yes |
| `@AutoinjectService`, `resolveNamedService(s)`, a `ConfigVar` resolved at construction | once | no |
| `@RateLimit({ config })` settings | once when the route mounts | no |
