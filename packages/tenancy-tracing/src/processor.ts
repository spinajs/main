import { SpanKind, trace } from '@opentelemetry/api';
import { onTenantScopeChange, tenantScope } from '@spinajs/tenancy';
import type { TenantScope } from '@spinajs/tenancy';
import { SpinaAttr } from '@spinajs/tracing';

/** The part of an OpenTelemetry span this processor reads and writes. */
export interface TenantSpanTarget {
  readonly kind?: SpanKind;
  setAttribute(key: string, value: string): unknown;
}

// No tenant id matches it: the id pattern has no '*'.
const ALL_TENANTS = '*';

const attributeOf = (scope: TenantScope): string => (scope.kind === 'tenant' ? scope.tenant.id : ALL_TENANTS);

// The HTTP server span starts before TenantMiddleware applies the scope; it is tagged once the scope arrives under it.
const unscopedServerSpans = new WeakSet<object>();

function scopeOrNone(): TenantScope | undefined {
  try {
    return tenantScope();
  } catch {
    // An app's own SDK may not guard its processors: a span without the attribute beats a failed span.
    return undefined;
  }
}

// Only a SERVER span from the set is tagged: runInTenant under a job span calls this guard too, and a job running
// across tenants must not take the first tenant it visits.
onTenantScopeChange((_from, to) => {
  try {
    const span = trace.getActiveSpan();
    if (to && span && unscopedServerSpans.delete(span)) span.setAttribute(SpinaAttr.Tenant, attributeOf(to));
  } catch {
    // A throwing guard refuses the scope change, and tracing must never fail a request.
  }
});

/**
 * Sets `spina.tenant.id` on every span when it starts: the tenant id in a tenant scope, `'*'` in the all-tenants
 * scope, nothing without a scope. A SERVER span started without a scope gets the scope the request applies under it.
 * Importing the package attaches one to the `@spinajs/tracing` hub; an app that owns its OpenTelemetry SDK adds
 * `new TenantSpanProcessor()` to it instead.
 */
export class TenantSpanProcessor {
  public onStart(span: TenantSpanTarget): void {
    const scope = scopeOrNone();
    if (scope) span.setAttribute(SpinaAttr.Tenant, attributeOf(scope));
    else if (span.kind === SpanKind.SERVER) unscopedServerSpans.add(span);
  }

  public onEnd(): void {}

  public forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  public shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
