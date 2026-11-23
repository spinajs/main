import { AuthzDomains } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { AuthzHttpRateLimit, CurrentPrincipal, ExplainPolicy } from '@spinajs/authz-http';
import { Config } from '@spinajs/configuration';
import { Autoinject } from '@spinajs/di';
import { BaseController, BasePath, Ok, Policy, Post } from '@spinajs/http';

import { ExplainInput, explainAccess } from '../authz/explain.js';
import type { StudioExplainInput } from '../contracts/index.js';
import { StudioAccessPolicy } from '../policies/StudioAccessPolicy.js';

/** A controller of its own, so StudioControllerSource can leave it out in production. */
@BasePath({ config: 'studio.path', default: '/_studio' })
export class StudioExplainController extends BaseController {
  @Autoinject(AuthzDomains)
  protected Domains: AuthzDomains;

  @Config('authz', { defaultValue: {} })
  protected AuthzTree: unknown;

  /**
   * Why a principal can or cannot do something, under current state.
   *
   * @returns {StudioExplainResult} The decision, its trace and the deny reasons by priority
   */
  @Post('api/authz/explain')
  @AuthzHttpRateLimit('explain')
  // One group, so both must pass: two @Policy() calls would admit a caller who passes either.
  @Policy([StudioAccessPolicy, ExplainPolicy], 'explain')
  public async explain(@ExplainInput() input: StudioExplainInput, @CurrentPrincipal() caller: Principal) {
    return new Ok(await explainAccess({ domains: this.Domains, authzTree: this.AuthzTree }, input, caller));
  }
}
