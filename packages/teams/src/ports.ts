import { GLOBAL } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { Injectable } from '@spinajs/di';

/** Where root teams hang: the scope `team:create` is checked at for a root team, and for a team moved to the root. */
export abstract class TeamRootScope {
  /** True for a root scope inside a tenant; `teams.tenancy: true` needs one (TeamsTenancyCheck). */
  public readonly tenancy: boolean = false;

  public abstract root(): ResourceRef;
}

/** Root teams hang directly under `$global`. */
@Injectable(TeamRootScope)
export class GlobalTeamRootScope extends TeamRootScope {
  public root(): ResourceRef {
    return GLOBAL;
  }
}
