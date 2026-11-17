import { AUTHZ_AUDIT_SERVICE_KEY, DecisionAudit, compareDenyReasons, pickNamed, readDomainConfig } from '@spinajs/authz';
import type { AuthzDomains, Decision, DenyReason, FieldSet, PrincipalRef, ResourceFilter, ResourceRef, Trace, TraceStep, Value, Vote } from '@spinajs/authz';
import { EXPLAIN_QUERY_PROPERTIES, resolveExplainRequest } from '@spinajs/authz-http';
import { Parameter, ParameterType, Route } from '@spinajs/http';

import type { StudioDecision, StudioExplainInput, StudioExplainResult } from '../contracts/index.js';
import { truncate } from '../span.js';
import { domainParam } from './domains.js';

/** `POST /api/authz/explain` body: the keys of `GET /authz/explain` (authz-http) with their limits, plus the domain. */
export const EXPLAIN_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['principal', 'permission'],
  properties: {
    domain: { type: 'string', pattern: '^[A-Za-z0-9_.-]{0,64}$' },
    principal: EXPLAIN_QUERY_PROPERTIES.principal,
    permission: EXPLAIN_QUERY_PROPERTIES.permission,
    resource: EXPLAIN_QUERY_PROPERTIES.resource,
  },
} as const;

/** The validated explain body as a route argument; an absent body is a 400. */
export function ExplainInput(): ReturnType<typeof Route> {
  return Route(Parameter(ParameterType.FromBody, EXPLAIN_INPUT_SCHEMA, { required: true }));
}

// Free-form parts of a decision (deny reason payloads, trace step data) hold whatever a model put there.
function cutJson(value: unknown): unknown {
  if (typeof value === 'string') return truncate(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(cutJson);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [truncate(k), cutJson(v)]));
  return undefined;
}

const cutRef = (ref: ResourceRef): ResourceRef => ({ type: truncate(ref.type), ...(ref.id === undefined ? {} : { id: truncate(ref.id) }) });
const cutPrincipal = (ref: PrincipalRef): PrincipalRef => ({ type: truncate(ref.type), id: truncate(ref.id) });
const cutRecord = (record: Readonly<Record<string, string>>): Record<string, string> => Object.fromEntries(Object.entries(record).map(([k, v]) => [truncate(k), truncate(v)]));

function cutValue(value: Value): Value {
  if (typeof value === 'string') return truncate(value);
  if (typeof value !== 'object' || value === null) return value;
  if ('ref' in value) return { ref: truncate(value.ref) };
  return value.map((v) => (typeof v === 'string' ? truncate(v) : v));
}

function cutFilter(filter: ResourceFilter): ResourceFilter {
  switch (filter.op) {
    case 'true':
    case 'false':
      return { op: filter.op };
    case 'and':
    case 'or':
      return { op: filter.op, args: filter.args.map(cutFilter) };
    case 'not':
      return { op: 'not', arg: cutFilter(filter.arg) };
    case 'cmp':
      return { op: 'cmp', field: truncate(filter.field), cmp: filter.cmp, ...(filter.value === undefined ? {} : { value: cutValue(filter.value) }) };
    case 'relation':
      return { op: 'relation', relation: truncate(filter.relation) };
    case 'under':
      return { op: 'under', scopes: filter.scopes.map(cutRef) };
    default:
      return { op: `native:${truncate(filter.op.slice('native:'.length))}`, ...(filter.args === undefined ? {} : { args: cutJson(filter.args) }) };
  }
}

function cutReason(reason: DenyReason): DenyReason {
  const payload = Object.entries(reason).filter(([k]) => k !== 'code' && k !== 'model' && k !== 'sortKey');
  return {
    ...Object.fromEntries(payload.map(([k, v]) => [truncate(k), cutJson(v)])),
    code: truncate(reason.code),
    ...(reason.model === undefined ? {} : { model: truncate(reason.model) }),
    ...(reason.sortKey === undefined ? {} : { sortKey: truncate(reason.sortKey) }),
  };
}

const cutList = (list: readonly string[] | undefined) => (list === undefined ? undefined : list.map(truncate));

function cutFields(fields: FieldSet): FieldSet {
  const [read, write, hide] = [cutList(fields.read), cutList(fields.write), cutList(fields.hide)];
  return { ...(read ? { read } : {}), ...(write ? { write } : {}), ...(hide ? { hide } : {}) };
}

const cutStep = (step: TraceStep): TraceStep => ({ by: truncate(step.by), step: truncate(step.step), note: truncate(step.note), ...(step.data === undefined ? {} : { data: cutJson(step.data) }) });

function cutVote(vote: Vote): Vote {
  return {
    model: truncate(vote.model),
    permitWhen: cutFilter(vote.permitWhen),
    denyWhen: cutFilter(vote.denyWhen),
    cacheable: vote.cacheable,
    ...(vote.denies ? { denies: vote.denies.map((d) => ({ when: cutFilter(d.when), reason: cutReason(d.reason) })) } : {}),
    ...(vote.error === undefined ? {} : { error: truncate(vote.error) }),
    ...(vote.reason ? { reason: cutReason(vote.reason) } : {}),
    ...(vote.roles ? { roles: cutRecord(vote.roles) } : {}),
    ...(vote.fields ? { fields: cutFields(vote.fields) } : {}),
    ...(vote.validUntil ? { validUntil: vote.validUntil } : {}),
    ...(vote.trace ? { trace: vote.trace.map(cutStep) } : {}),
  };
}

/** The trace as the reply carries it: every string cut at 2 KiB, field by field. */
export function toStudioTrace(trace: Trace): Trace {
  return { domain: truncate(trace.domain), algorithm: trace.algorithm, models: trace.models.map(truncate), votes: trace.votes.map(cutVote), steps: trace.steps.map(cutStep), durationMs: trace.durationMs };
}

/** The decision as JSON carries it: `validUntil` as an ISO string, the trace left to `StudioExplainResult.trace`, every string cut at 2 KiB. */
export function toStudioDecision(decision: Decision): StudioDecision {
  return {
    allowed: decision.allowed,
    permission: decision.permission,
    resource: cutRef(decision.resource),
    principal: cutPrincipal(decision.principal),
    ...(decision.actor ? { actor: cutPrincipal(decision.actor) } : {}),
    residual: cutFilter(decision.residual),
    fields: { read: decision.fields.read.map(truncate), write: decision.fields.write.map(truncate) },
    roles: cutRecord(decision.roles),
    ...(decision.reason ? { reason: cutReason(decision.reason) } : {}),
    ...(decision.validUntil ? { validUntil: decision.validUntil.toISOString() } : {}),
    domain: decision.domain,
    ...(decision.id === undefined ? {} : { id: decision.id }),
  };
}

/** Every deny reason of the votes (`Trace` has no `denies[]`), once each, lowest priority first. */
export function collectDenies(decision: Decision): DenyReason[] {
  const all: DenyReason[] = [];
  for (const vote of decision.trace?.votes ?? []) {
    if (vote.reason) all.push(vote.reason);
    for (const d of vote.denies ?? []) all.push(d.reason);
  }
  if (all.length === 0 && decision.reason) all.push(decision.reason);
  const unique = new Map(all.map((r) => [JSON.stringify(r), r]));
  return [...unique.values()].sort(compareDenyReasons);
}

export async function explainAccess(ctx: { domains: AuthzDomains; authzTree: unknown }, input: StudioExplainInput, caller: PrincipalRef): Promise<StudioExplainResult> {
  const domain = domainParam(ctx.domains, input.domain);
  const request = resolveExplainRequest(input);
  // An explicit request, so it may boot the domain, unlike the read-only model endpoints.
  const decision = await (await ctx.domains.service(domain)).explain(request);

  const cfg = readDomainConfig(ctx.authzTree, ctx.domains.lineage(domain));
  const audit = await pickNamed(ctx.domains.container(domain), DecisionAudit, cfg.audit.service, AUTHZ_AUDIT_SERVICE_KEY, 'studio explain');
  // The engine's own explain entry names the principal asked about; only Studio knows who asked.
  await audit?.record({ kind: 'explain', principal: { type: caller.type, id: caller.id }, permission: request.permission, resource: request.resource, reason: `studio explain for ${request.principal.type}:${request.principal.id}`, ...(decision.trace ? { trace: decision.trace } : {}) });

  return { decision: toStudioDecision(decision), ...(decision.trace ? { trace: toStudioTrace(decision.trace) } : {}), denies: collectDenies(decision).map(cutReason) };
}
