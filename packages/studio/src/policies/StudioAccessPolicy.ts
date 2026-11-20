import { AuthzContributor } from '@spinajs/authz';
import { ACCESS_SLOT, SlotAccessContributor, SlotAccessPolicy } from '@spinajs/authz-http';
import type { SlotSettings } from '@spinajs/authz-http';
import { Config } from '@spinajs/configuration';
import { Injectable, NewInstance, Singleton } from '@spinajs/di';
import { Policy } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log';

/** The slot value that checks `studio.auth.permissions.<endpoint>` through authz. */
export const STUDIO_ACCESS_SLOT = ACCESS_SLOT;

/** Guards one Studio endpoint by its slot `studio.auth.policies.<endpoint>` ({@link SlotAccessPolicy}). */
@NewInstance()
export class StudioAccessPolicy extends SlotAccessPolicy {
  protected readonly module = 'studio';

  @Logger('Security')
  protected Log: Log;

  @Config('studio.auth.policies', { defaultValue: {} })
  protected Policies: Record<string, string>;

  @Config('studio.auth.permissions', { defaultValue: {} })
  protected Permissions: Record<string, string | string[]>;

  @Config('studio.auth.domain', { defaultValue: 'root' })
  protected Domain: string;

  @Config('studio.auth.skipInDevelopment')
  protected SkipInDevelopment: unknown;

  @Config('configuration.isProduction')
  protected IsProduction: unknown;

  protected slotSettings(): SlotSettings {
    return { policies: this.Policies, permissions: this.Permissions, domain: this.Domain, skipInDevelopment: this.SkipInDevelopment, isProduction: this.IsProduction };
  }
}

/** Guards a route by the Studio slot `studio.auth.policies.<endpoint>`. */
export function StudioAccess(endpoint: string) {
  return Policy(StudioAccessPolicy, endpoint);
}

/** The permissions of Studio's `'AccessPolicy'` slots, for the boot checks of `studio.auth.domain`. */
@Injectable(AuthzContributor)
@Singleton()
export class StudioAccessContributor extends SlotAccessContributor {
  protected readonly module = 'studio';

  @Config('studio.auth.domain', { defaultValue: 'root' })
  protected Domain: string;

  @Config('studio.auth.policies', { defaultValue: {} })
  protected Policies: Record<string, string>;

  @Config('studio.auth.permissions', { defaultValue: {} })
  protected Permissions: Record<string, string | string[]>;

  protected slotSettings() {
    return { policies: this.Policies, permissions: this.Permissions, domain: this.Domain };
  }
}
