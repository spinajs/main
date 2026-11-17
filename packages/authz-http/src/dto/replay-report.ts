import { fieldSchema } from '@spinajs/authz';
import { Param, Query } from '@spinajs/http';
import { Schema } from '@spinajs/validation';

const str = { type: 'string' } as const;
const truth = { enum: ['allow', 'deny', 'unknown'] } as const;
const list = (properties: Record<string, object>, required: readonly string[]) => ({ type: 'array', items: { type: 'object', required, properties } }) as const;
// Recursive: children are nodes of the same shape, left open here because not every OpenAPI consumer follows a $ref cycle.
const treeNode = { type: ['object', 'null'], required: ['label', 'truth', 'source', 'children'], properties: { label: str, truth, source: str, children: { type: 'array', items: { type: 'object' } }, tupleContext: { type: 'array', items: str } } } as const;

/** `ReplayReport` of `@spinajs/authz`: the answer of `GET /authz/decisions/:id/explain`, the contract Spina Studio reads. */
export const REPLAY_REPORT_SCHEMA = fieldSchema('authz.http.replayReport', {
  type: 'object',
  required: ['decision', 'currentPolicy', 'replay', 'outcome', 'inputsHash', 'missing', 'divergence', 'tree', 'reads', 'limits'],
  properties: {
    decision: {
      type: 'object',
      required: ['id', 'at', 'domain', 'principal', 'permission', 'resource', 'allowed', 'cached', 'policyHash', 'inputsHash'],
      description: 'The decision record without its captured inputs and facts; traceId and spanId link it to its authz.check span',
    },
    currentPolicy: { type: 'boolean', description: "the record's policy hash is the one its domain runs now" },
    replay: { enum: ['faithful', 'divergent', 'unreplayable'] },
    evidence: { enum: ['inputs-hash', 'outcome'] },
    outcome: { type: 'object', required: ['recorded', 'replayed'], properties: { recorded: { enum: ['allow', 'deny'] }, replayed: { enum: ['allow', 'deny', 'unknown', null] } } },
    inputsHash: { type: 'object', required: ['recorded', 'replayed'], properties: { recorded: str, replayed: { type: ['string', 'null'] } } },
    missing: list({ input: str, reason: str, key: str }, ['input', 'reason']),
    divergence: list({ part: { enum: ['outcome', 'inputs-hash', 'policy-hash', 'captured-state'] }, recorded: str, replayed: str, key: str }, ['part', 'recorded', 'replayed']),
    tree: treeNode,
    reads: list({ kind: str, key: str, origin: { enum: ['current', 'history', 'gap'] }, seq: { type: 'integer' }, reason: str }, ['key', 'origin']),
    limits: { type: 'object', required: ['changes', 'maxChanges', 'keys', 'durationMs'], properties: { changes: { type: 'integer' }, maxChanges: { type: 'integer' }, keys: { type: 'integer' }, durationMs: { type: 'number' } } },
  },
} as const);

/** Names `REPLAY_REPORT_SCHEMA` for http-swagger, which resolves `@returns {ReplayReportDto}` through `@Schema`. */
@Schema(REPLAY_REPORT_SCHEMA)
export class ReplayReportDto {}

/** The `:id` of the decisions route: the decision record's UUIDv7, the `decisionId` of its 403. */
export function DecisionIdParam(): ReturnType<typeof Param> {
  return Param({ type: 'string', format: 'uuid' }, { required: true });
}

/** `format=report|tree` of the decisions route; empty or absent is `report`. */
export function DecisionsFormatQuery(): ReturnType<typeof Query> {
  return Query({ enum: ['', 'report', 'tree'] });
}
