import { AuthzDomains, isPermission, parsePermission } from '@spinajs/authz';
import type { Permission, Principal } from '@spinajs/authz';
import { Config, effectiveManifestOf } from '@spinajs/configuration';
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Get, Ok, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';

import type { StudioCapabilities } from '../contracts/index.js';
import { configuredEnvOf, studioSkipsAuth } from '../development.js';
import { detectFeatures } from '../features.js';
import { StudioAccess } from '../policies/StudioAccessPolicy.js';
import { tracingCapability } from '../tracing-capability.js';
import { STUDIO_VERSION } from '../version.js';

@BasePath({ config: 'studio.path', default: '/_studio' })
export class StudioCapabilitiesController extends BaseController {
  @Autoinject(Container)
  protected Container: IContainer;

  @Autoinject(AuthzDomains)
  protected Domains: AuthzDomains;

  @Config('studio.auth.permissions', { defaultValue: {} })
  protected Permissions: Record<string, string | string[]>;

  @Config('studio.auth.domain', { defaultValue: 'root' })
  protected Domain: string;

  @Config('studio.auth.skipInDevelopment')
  protected SkipInDevelopment: unknown;

  @Config('configuration.isProduction')
  protected IsProduction: unknown;

  /**
   * What this Studio can show and what the caller may open.
   *
   * @returns Version, manifest, tracing owner, features and held permissions
   */
  @Get('api/capabilities')
  @StudioAccess('capabilities')
  public async capabilities(@Req() req: Request) {
    const body: StudioCapabilities = {
      version: STUDIO_VERSION,
      manifest: this.manifest(),
      tracing: tracingCapability(),
      features: await detectFeatures(this.Container),
      permissions: await this.heldPermissions(req.storage.Principal),
    };
    return new Ok(body);
  }

  protected manifest(): StudioCapabilities['manifest'] {
    const effective = effectiveManifestOf(this.Container);
    if (!effective) return { loaded: false };
    return { loaded: effective.manifest !== undefined, mode: effective.settings.mode, ...(effective.manifest ? { hash: effective.manifest.hash } : {}) };
  }

  protected async heldPermissions(principal: Principal | undefined): Promise<string[]> {
    const wanted = [...new Set(Object.values(this.Permissions).flatMap((p) => (typeof p === 'string' ? [p] : p)))].filter((p): p is Permission => isPermission(p));
    if (studioSkipsAuth({ skipInDevelopment: this.SkipInDevelopment, isProduction: this.IsProduction, configuredEnv: configuredEnvOf(this) })) return wanted;
    if (!principal) return [];

    const authz = await this.Domains.service(this.Domain);
    const held: string[] = [];
    for (const permission of wanted) {
      if (await authz.can(principal, permission, { type: parsePermission(permission).resource })) held.push(permission);
    }
    return held;
  }
}
