import { tenantScope } from '@spinajs/tenancy';
import type { TenantScope } from '@spinajs/tenancy';
import { SpinaAttr } from '@spinajs/tracing';

/** The part of an OpenTelemetry span this processor writes to. */
export interface TenantSpanTarget {
  setAttribute(key: string, value: string): unknown;
}

// No tenant id matches it: the id pattern has no '*'.
const ALL_TENANTS = '*';

function scopeOrNone(): TenantScope | undefined {
  try {
    return tenantScope();
  } catch {
    // An app's own SDK may not guard its processors: a span without the attribute beats a failed span.
    return undefined;
  }
}

/**
 * Sets `spina.tenant.id` on every span when it starts: the tenant id in a tenant scope, `'*'` in the all-tenants
 * scope, nothing without a scope. Importing the package attaches one to the `@spinajs/tracing` hub; an app that owns
 * its OpenTelemetry SDK adds `new TenantSpanProcessor()` to it instead.
 */
export class TenantSpanProcessor {
  public onStart(span: TenantSpanTarget): void {
    const scope = scopeOrNone();
    if (scope) span.setAttribute(SpinaAttr.Tenant, scope.kind === 'tenant' ? scope.tenant.id : ALL_TENANTS);
  }

  public onEnd(): void {}

  public forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  public shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
