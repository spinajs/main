# Slot access policies

A package that ships HTTP endpoints, such as `@spinajs/telemetry` or `@spinajs/studio`, lets the application decide who may open each of them through configuration instead of code. Each endpoint has a **slot**, `<module>.auth.policies.<endpoint>`, and `SlotAccessPolicy` guards the route by what the slot says. `TelemetryAccessPolicy` and `StudioAccessPolicy` are built on it.

## What a slot holds

| Slot value | What guards the route |
| --- | --- |
| `'AccessPolicy'` (`ACCESS_SLOT`) | [`AccessPolicy`](01-protecting-routes.md): any of `<module>.auth.permissions.<endpoint>` on the permission's type-level resource, checked in `<module>.auth.domain` (default `'root'`). 401 without an authenticated principal, 403 when every permission is denied. |
| The class name of a registered `BasePolicy` | That policy decides, `isEnabled` included. |

The slot is read once, when http registers the route, from the Configuration of the container that resolves the policy. It fails closed: the route never registers, with a `RouteRegistrationException` naming the key, when

- the slot is not set, which includes a module with no `<module>.auth` configuration at all or an empty `policies` object;
- the slot names a class that is not a registered `BasePolicy`, or the slot policy itself;
- an `'AccessPolicy'` slot has no `<module>.auth.permissions.<endpoint>` entry.

`SlotAccessContributor` feeds the permissions of every `'AccessPolicy'` slot to the boot checks of `<module>.auth.domain`, so a permission the domain does not declare fails its boot instead of the first request. Permissions of other domains' slots and of named-policy slots are not contributed.

## Development skip

An `'AccessPolicy'` slot lets every request through only when all three hold:

1. `<module>.auth.skipInDevelopment` is `true` as the policy reads it, which is after configuration validation: a module whose schema types the flag `boolean`, as Studio's and telemetry's do, has `'true'` and `1` coerced to `true` at boot, so those values turn the skip on too, and any other value fails validation. Without such a schema the value must be exactly `true`;
2. `configuration.isProduction` is not `true`;
3. the env names development: the env the configuration loaded (`--env`, else `APP_ENV`), else `APP_ENV`, else `NODE_ENV`, normalized to `'dev'`. A missing env counts as production.

The route then logs a warning naming the endpoint when it registers. A slot that names a policy is never skipped. The same decision is exported as `skipsAuthInDevelopment(settings, env?)`, with `isExplicitDevelopment(env?, configuredEnv?)` for the env test and `configuredEnvOf(instance)` for the env of the Configuration an instance's `@Config()` properties read.

## Guarding your own package's endpoints

A subclass names its module and reads its keys with `@Config()`, so each instance reads the configuration of the container that resolves it. The decorator attaches the policy with the endpoint name; the contributor reads the same keys.

```ts sample
import { AuthzContributor } from '@spinajs/authz';
import { SlotAccessContributor, SlotAccessPolicy } from '@spinajs/authz-http';
import type { SlotSettings } from '@spinajs/authz-http';
import { Config } from '@spinajs/configuration';
import { Injectable, NewInstance, Singleton } from '@spinajs/di';
import { Policy } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log';

@NewInstance()
export class ReportsAccessPolicy extends SlotAccessPolicy {
  protected readonly module = 'reports';

  @Logger('Security')
  protected Log: Log;

  @Config('reports.auth.policies', { defaultValue: {} })
  protected Policies: Record<string, string>;

  @Config('reports.auth.permissions', { defaultValue: {} })
  protected Permissions: Record<string, string | string[]>;

  @Config('reports.auth.domain', { defaultValue: 'root' })
  protected Domain: string;

  @Config('reports.auth.skipInDevelopment')
  protected SkipInDevelopment: unknown;

  @Config('configuration.isProduction')
  protected IsProduction: unknown;

  protected slotSettings(): SlotSettings {
    return { policies: this.Policies, permissions: this.Permissions, domain: this.Domain, skipInDevelopment: this.SkipInDevelopment, isProduction: this.IsProduction };
  }
}

export function ReportsAccess(endpoint: string) {
  return Policy(ReportsAccessPolicy, endpoint);
}

@Injectable(AuthzContributor)
@Singleton()
export class ReportsAccessContributor extends SlotAccessContributor {
  protected readonly module = 'reports';

  @Config('reports.auth.policies', { defaultValue: {} })
  protected Policies: Record<string, string>;

  @Config('reports.auth.permissions', { defaultValue: {} })
  protected Permissions: Record<string, string | string[]>;

  @Config('reports.auth.domain', { defaultValue: 'root' })
  protected Domain: string;

  protected slotSettings() {
    return { policies: this.Policies, permissions: this.Permissions, domain: this.Domain };
  }
}
```

A route takes `@ReportsAccess('export')`, and the application fills the slot:

```ts
export default {
  reports: {
    auth: {
      policies: { export: 'AccessPolicy' },
      permissions: { export: ['reports:export', 'ops:debug'] },
    },
  },
  authz: { permissions: { 'reports:export': {}, 'ops:debug': {} } },
};
```

The class name of the policy is what manifests and the compiler record, so keep it stable once released.
