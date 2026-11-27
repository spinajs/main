import { AuthzContributor } from '@spinajs/authz';
import type { AuthzContribution } from '@spinajs/authz';
import { CONFIGURATION_SCHEMA, Configuration } from '@spinajs/configuration';
import { DI, Injectable, Singleton } from '@spinajs/di';
import { InvalidOption } from '@spinajs/exceptions';

import { rootScope } from './host.js';
import type { TeamRootScope } from './ports.js';

/** `@spinajs/tenancy` registers the configuration schema of module `tenancy` when it is imported. */
function tenancyImported(): boolean {
  const schemas: unknown = DI.RootContainer.Cache.get(CONFIGURATION_SCHEMA.key, false);
  return Array.isArray(schemas) && schemas.some((s: unknown) => s !== null && typeof s === 'object' && Reflect.get(s, '$configurationModule') === 'tenancy');
}

/**
 * With tenancy in use, `teams.tenancy` must say whether teams live inside tenants, and agree with the root scope the
 * teams bridge registers; otherwise teams would span tenants.
 */
export function checkTeamsTenancy(setting: unknown, tenancy: boolean, scope: TeamRootScope): void {
  if (setting === undefined) {
    if (tenancy || scope.tenancy) throw new InvalidOption('teams.tenancy must be true or false when @spinajs/tenancy is in use: true puts teams inside tenants (import @spinajs/tenancy-orm/teams), false keeps them global');
    return;
  }
  if (typeof setting !== 'boolean') throw new InvalidOption('teams.tenancy must be true or false');
  if (setting && !scope.tenancy) throw new InvalidOption('teams.tenancy is true, but @spinajs/tenancy-orm/teams is not imported: teams would stay global');
  if (!setting && scope.tenancy) throw new InvalidOption('teams.tenancy is false, but @spinajs/tenancy-orm/teams is imported and puts teams inside tenants');
}

/** Runs the check at every authz domain boot, which every app using teams has. */
@Singleton()
@Injectable(AuthzContributor)
export class TeamsTenancyCheck extends AuthzContributor {
  public contribute(_domain: string): AuthzContribution {
    checkTeamsTenancy(DI.get(Configuration)?.get<unknown>(['teams', 'tenancy']), tenancyImported(), rootScope());
    return {};
  }
}
