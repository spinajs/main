import { AuthzContributor } from '@spinajs/authz';
import { ACCESS_SLOT, SlotAccessContributor, SlotAccessPolicy } from '@spinajs/authz-http';
import type { SlotSettings } from '@spinajs/authz-http';
import { Config } from '@spinajs/configuration';
import { Injectable, NewInstance, Singleton } from '@spinajs/di';
import { Policy } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log';

/** The slot value that checks `telemetry.auth.permissions.<endpoint>` through authz. */
export const TELEMETRY_ACCESS_SLOT = ACCESS_SLOT;

/** Guards one telemetry endpoint by its slot `telemetry.auth.policies.<endpoint>` ({@link SlotAccessPolicy}). */
@NewInstance()
export class TelemetryAccessPolicy extends SlotAccessPolicy {
  protected readonly module = 'telemetry';

  @Logger('Security')
  protected Log: Log;

  @Config('telemetry.auth.policies', { defaultValue: {} })
  protected Policies: Record<string, string>;

  @Config('telemetry.auth.permissions', { defaultValue: {} })
  protected Permissions: Record<string, string | string[]>;

  @Config('telemetry.auth.domain', { defaultValue: 'root' })
  protected Domain: string;

  @Config('telemetry.auth.skipInDevelopment')
  protected SkipInDevelopment: unknown;

  @Config('configuration.isProduction')
  protected IsProduction: unknown;

  protected slotSettings(): SlotSettings {
    return { policies: this.Policies, permissions: this.Permissions, domain: this.Domain, skipInDevelopment: this.SkipInDevelopment, isProduction: this.IsProduction };
  }
}

/** Guards a route by the telemetry slot `telemetry.auth.policies.<endpoint>`. */
export function TelemetryAccess(endpoint: string) {
  return Policy(TelemetryAccessPolicy, endpoint);
}

/**
 * The permissions of telemetry's `'AccessPolicy'` slots, for the boot checks of `telemetry.auth.domain`.
 * A root singleton, so a domain container that resolves it still reads the slots TelemetryAccessPolicy enforces.
 */
@Injectable(AuthzContributor)
@Singleton()
export class TelemetryAccessContributor extends SlotAccessContributor {
  protected readonly module = 'telemetry';

  @Config('telemetry.auth.domain', { defaultValue: 'root' })
  protected Domain: string;

  @Config('telemetry.auth.policies', { defaultValue: {} })
  protected Policies: Record<string, string>;

  @Config('telemetry.auth.permissions', { defaultValue: {} })
  protected Permissions: Record<string, string | string[]>;

  protected slotSettings() {
    return { policies: this.Policies, permissions: this.Permissions, domain: this.Domain };
  }
}
