import { AuthzDomains } from '@spinajs/authz';
import { Config } from '@spinajs/configuration';
import { Autoinject } from '@spinajs/di';
import { ResourceNotFound } from '@spinajs/exceptions';
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

import { MAX_DOMAIN_LIMIT, describeDomains, domainParam } from '../authz/domains.js';
import { rbacRolesOf, rolesGraph } from '../authz/roles.js';
import type { StudioAuthzDomain, StudioPage } from '../contracts/index.js';
import { DepthQuery, GraphBuilder, MAX_GRAPH_LIMIT, graphView, viewOf } from '../graph/graph.js';
import { StudioAccess } from '../policies/StudioAccessPolicy.js';
import { DomainQuery, LimitQuery, OffsetCursorQuery, TextQuery } from '../queries/params.js';

@BasePath({ config: 'studio.path', default: '/_studio' })
export class StudioAuthzController extends BaseController {
  @Autoinject(AuthzDomains)
  protected Domains: AuthzDomains;

  @Config('authz', { defaultValue: {} })
  protected AuthzTree: unknown;

  /**
   * Authz domains: models of booted domains, algorithms and the permission catalogue.
   *
   * @returns {StudioPage} One entry per domain, root first
   */
  @Get('api/authz/domains')
  @StudioAccess('authz')
  public async domains(@LimitQuery(MAX_DOMAIN_LIMIT) limit?: number, @OffsetCursorQuery() cursor?: number) {
    const names = this.Domains.names();
    const offset = cursor ?? 0;
    const end = offset + (limit ?? MAX_DOMAIN_LIMIT);
    const page: StudioPage<StudioAuthzDomain> = { items: describeDomains(this.Domains, this.AuthzTree, names.slice(offset, end)), total: names.length, ...(end < names.length ? { cursor: String(end) } : {}) };
    return new Ok(page);
  }

  /**
   * The RBAC role graph of a domain; empty when no RBAC model is booted there.
   *
   * @returns {StudioGraph} Roles, permissions, inherits/ladder/grants edges
   */
  @Get('api/authz/roles')
  @StudioAccess('authz')
  public async roles(@DomainQuery() domain?: string, @TextQuery() focus?: string, @DepthQuery() depth?: number, @LimitQuery(MAX_GRAPH_LIMIT) limit?: number) {
    const view = graphView({ focus, group: undefined, depth, limit });
    const roles = rbacRolesOf(this.Domains, domainParam(this.Domains, domain));
    const graph = roles ? rolesGraph(roles) : new GraphBuilder().build('runtime');
    // A focus is a node id as it is: a role and a permission of the same name have different ids.
    if (view.focus !== undefined && !graph.nodes.some((n) => n.id === view.focus)) throw new ResourceNotFound(`no role graph node ${view.focus}`);
    return new Ok(viewOf(graph, view));
  }
}
