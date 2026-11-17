import { AuthzDomains } from '@spinajs/authz';
import { Autoinject } from '@spinajs/di';
import { BadRequest, ResourceNotFound } from '@spinajs/exceptions';
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

import { domainParam } from '../authz/domains.js';
import { namespacesGraph, parseFocus, rebacOf, relationsGraph, toStudioTuple } from '../authz/rebac.js';
import type { RebacLike, TupleQueryLike } from '../authz/rebac.js';
import type { StudioPage, StudioTuple } from '../contracts/index.js';
import { DEFAULT_GRAPH_LIMIT, DepthQuery, MAX_GRAPH_LIMIT, viewOf } from '../graph/graph.js';
import { StudioAccess } from '../policies/StudioAccessPolicy.js';
import { DomainQuery, LimitQuery, OffsetCursorQuery, TextQuery, given } from '../queries/params.js';

const TUPLE_PAGE = 50;
const MAX_TUPLE_PAGE = 500;
// The focus syntax without `#relation`; the id is everything after the first colon.
const OBJECT = /^[^:#\s]+(?::[^#\s]+)?$/;

// `object=document` (no id) selects the whole namespace, as the tuple query allows.
function objectRef(raw: string): NonNullable<TupleQueryLike['object']> {
  if (!OBJECT.test(raw)) throw new BadRequest('object must be type or type:id');
  const colon = raw.indexOf(':');
  return colon < 0 ? { type: raw } : { type: raw.slice(0, colon), id: raw.slice(colon + 1) };
}

function subjectOf(raw: string): NonNullable<TupleQueryLike['subject']> {
  const s = parseFocus(raw, 'subject');
  return s.relation ? { object: { type: s.type, id: s.id }, relation: s.relation } : { type: s.type, id: s.id };
}

function tupleQuery(object: string | undefined, relation: string | undefined, subject: string | undefined): TupleQueryLike {
  return { ...(object ? { object: objectRef(object) } : {}), ...(relation ? { relation } : {}), ...(subject ? { subject: subjectOf(subject) } : {}) };
}

@BasePath({ config: 'studio.path', default: '/_studio' })
export class StudioRebacController extends BaseController {
  @Autoinject(AuthzDomains)
  protected Domains: AuthzDomains;

  /** @returns {StudioGraph} The ReBAC namespaces as a schema graph */
  @Get('api/authz/namespaces')
  @StudioAccess('authz')
  public async namespaces(@DomainQuery() domain?: string, @LimitQuery(MAX_GRAPH_LIMIT) limit?: number) {
    return new Ok(viewOf(namespacesGraph(this.model(domain).schema()), { limit: limit ?? DEFAULT_GRAPH_LIMIT }));
  }

  /** @returns {StudioPage} Stored tuples with a total; `cursor` is opaque */
  @Get('api/authz/tuples')
  @StudioAccess('authz')
  public async tuples(
    @DomainQuery() domain?: string,
    @TextQuery() object?: string,
    @TextQuery() relation?: string,
    @TextQuery() subject?: string,
    @LimitQuery(MAX_TUPLE_PAGE) limit?: number,
    @OffsetCursorQuery() cursor?: number,
  ) {
    const query = tupleQuery(given(object), given(relation), given(subject));
    const offset = cursor ?? 0;
    const { items, total } = await this.model(domain).store().find(query, { limit: limit ?? TUPLE_PAGE, offset });
    const end = offset + items.length;
    const page: StudioPage<StudioTuple> = { items: items.map(toStudioTuple), total, ...(end < total ? { cursor: String(end) } : {}) };
    return new Ok(page);
  }

  /** @returns {StudioGraph} Objects and usersets around the focus */
  @Get('api/authz/relations/graph')
  @StudioAccess('authz')
  public async relations(@TextQuery({ required: true }) focus: string, @DomainQuery() domain?: string, @DepthQuery() depth?: number, @LimitQuery(MAX_GRAPH_LIMIT) limit?: number) {
    const from = parseFocus(focus);
    return new Ok(await relationsGraph(this.model(domain), from, depth ?? 2, limit ?? DEFAULT_GRAPH_LIMIT));
  }

  protected model(domain: string | undefined): RebacLike {
    const name = domainParam(this.Domains, domain);
    const model = rebacOf(this.Domains, name);
    if (!model) throw new ResourceNotFound(`no booted ReBAC model in authz domain ${name}`);
    return model;
  }
}
