import { BUILTIN_CONDITION_FUNCTIONS, parseResourceKey, resourceKey } from '@spinajs/authz';
import type { Condition, DecisionRecord, PrincipalFactsRecord, ReplayMissing } from '@spinajs/authz';

import type { CaveatContext } from '../eval/caveats.js';
import { GLOBAL_TYPE } from '../ir.js';
import type { PolicyIR, PrincipalFacts } from '../ir.js';
import type { ReplayWindow } from './history.js';

/** Reason codes the engine gives before or outside the policy: the IR does not model them. */
const OUTSIDE_POLICY: ReadonlySet<string> = new Set(['model_error', 'needs_subject', 'unattended', 'anonymous', 'unknown_resource', 'invalid_request']);
const BUILTIN_FUNCTIONS: ReadonlySet<string> = new Set(BUILTIN_CONDITION_FUNCTIONS.map((f) => f.name));
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const NUMBER_TAG = /^<number:(NaN|Infinity|-Infinity)>$/;
const OPAQUE_TAG = /^<(bigint|function|symbol|cycle|invalid date)>$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const entriesOf = (v: Record<string, unknown>, f: (k: string, x: unknown) => [string, unknown] | undefined): Record<string, unknown> =>
  Object.fromEntries(Object.entries(v).flatMap(([k, x]) => {
    const e = f(k, x);
    return e === undefined || e[1] === undefined ? [] : [e];
  }));

/** T, the instant the state is rebuilt at: when the tap logged the decision. `at` may be the caller's `env.now`. */
export const instantOf = (record: DecisionRecord): Date => new Date(record.loggedAt ?? record.at);

/** Section 3.2: the decision's reads happened up to `durationMs` before T, and commit lag only hides changes before T. */
export const replayWindow = (record: DecisionRecord, limits: { clockSkewMs: number; commitLagMs: number }): ReplayWindow => ({
  beforeMs: (record.durationMs ?? 0) + limits.clockSkewMs + limits.commitLagMs,
  afterMs: limits.clockSkewMs,
});

const missing = (input: string, reason: string, key?: string): ReplayMissing => (key === undefined ? { input, reason } : { input, reason, key });

/** Rule 1 of section 3.6 where it needs no policy: a record the replay cannot rebuild a check from. */
export function recordProblems(record: DecisionRecord, truncated: readonly string[]): ReplayMissing[] {
  const malformed = malformedField(record);
  if (malformed !== undefined) return [missing('record', `the record is malformed: ${malformed}`)];
  const out = truncated.map((k) => missing('record', `the logged ${k} key was cut to its column width`, k));
  if ((record.resource.id === undefined || record.resource.id === null) && record.resource.type !== GLOBAL_TYPE) out.push(missing('resource', 'type-level and filter decisions are not replayed', resourceKey(record.resource)));
  if (record.reason !== undefined && OUTSIDE_POLICY.has(record.reason)) out.push(missing('reason', 'the engine decided it before or outside the policy', record.reason));
  const principal = parseResourceKey(record.principal).type;
  if (principal === 'system' || principal === 'unattended') out.push(missing('principal', 'SYSTEM and UNATTENDED are decided outside the policy', record.principal));
  if (companionsOf(record.facts?.principal) || companionsOf(record.facts?.actor)) out.push(missing('principal.companions', 'the IR has no companions'));
  return out;
}

/** Rule 1 where it needs the policy: narrowing the record cannot reproduce, and actor caveats. */
export function policyProblems(record: DecisionRecord, ir: PolicyIR): ReplayMissing[] {
  const out: ReplayMissing[] = [];
  if (record.facts === undefined && (ir.principal.ceiling || ir.principal.delegation)) out.push(missing('principal-facts', record.loggedAt === undefined ? 'logged before records carried principal facts' : 'the facts were not logged (over 4 KB or unreadable)'));
  const actorCaveats = Object.entries(ir.caveats).flatMap(([name, def]) => (conditionReads(def.expr).some((p) => p.startsWith('actor.')) ? [name] : []));
  if (record.actor !== undefined && record.actor !== record.principal && actorCaveats.length > 0) out.push(missing('actor', 'the IR reads actor.* as the principal', actorCaveats.join(',')));
  return out;
}

function malformedField(r: DecisionRecord): string | undefined {
  const checks: Array<[string, () => boolean]> = [
    ['id', () => typeof r.id === 'string' && typeof r.permission === 'string' && typeof r.allowed === 'boolean'],
    ['at', () => typeof r.at === 'string' && !Number.isNaN(Date.parse(r.at)) && (r.loggedAt === undefined || !Number.isNaN(Date.parse(r.loggedAt)))],
    ['durationMs', () => r.durationMs === undefined || (Number.isFinite(r.durationMs) && r.durationMs >= 0)],
    ['principal', () => typeof r.principal === 'string' && validKey(r.principal)],
    ['resource', () => isRecord(r.resource) && typeof r.resource.type === 'string' && (r.resource.id == null || typeof r.resource.id === 'string')],
    ['policyHash', () => typeof r.policyHash === 'string' && typeof r.inputsHash === 'string'],
    ['facts', () => r.facts === undefined || (isRecord(r.facts) && validFacts(r.facts.principal) && (r.facts.actor === undefined || validFacts(r.facts.actor)))],
    ['inputs', () => r.inputs === undefined || validInputs(r.inputs)],
  ];
  return checks.find(([, ok]) => !ok())?.[0];
}

function validKey(key: string): boolean {
  try {
    return parseResourceKey(key).id !== undefined;
  } catch {
    return false;
  }
}

const validFacts = (f: unknown): boolean => isRecord(f) && typeof f.type === 'string' && typeof f.id === 'string' && (f.onBehalfOf === undefined || validFacts(f.onBehalfOf));
const validInputs = (i: unknown): boolean =>
  isRecord(i) && isRecord(i.env) && Array.isArray(i.attributes) && Array.isArray(i.relations) && isRecord(i.modelVersions) && (i.principalState === null || typeof i.principalState === 'string') && (i.actorState === null || typeof i.actorState === 'string');
const companionsOf = (f: PrincipalFactsRecord | undefined): boolean => f !== undefined && ((f.companions?.length ?? 0) > 0 || companionsOf(f.onBehalfOf));

/** Every context path a condition reads (`attr`, `{ ref }` operands, what built-in functions read), and `fn.<name>` per app function. */
export const conditionReads = (c: Condition): string[] => readsOf(c);

function readsOf(c: unknown): string[] {
  if (!isRecord(c)) return [];
  if (typeof c.fn === 'string') {
    const out = refsIn(c.args);
    if (!BUILTIN_FUNCTIONS.has(c.fn)) out.push(`fn.${c.fn}`);
    if (c.fn === 'ip.in' && !(isRecord(c.args) && own(c.args, 'ip'))) out.push('env.ip');
    if (c.fn === 'time.between') out.push('env.now');
    return out;
  }
  if (typeof c.attr === 'string') return [c.attr, ...Object.entries(c).flatMap(([k, v]) => (k === 'attr' ? [] : refsIn(v)))];
  return [c.all, c.any, c.not].flatMap((sub) => (Array.isArray(sub) ? sub.flatMap(readsOf) : readsOf(sub)));
}

function refsIn(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(refsIn);
  if (!isRecord(v)) return [];
  const keys = Object.keys(v);
  if (keys.length === 1 && keys[0] === 'ref' && typeof v.ref === 'string') return [v.ref];
  return Object.values(v).flatMap(refsIn);
}

/** The principal, the caveat context and the instant a replay evaluates with, and the paths it cannot vouch for. */
export interface ReplayContext {
  principal: PrincipalFacts;
  context: CaveatContext;
  /** What caveats and ceilings see: the decision's own instant (`at`), not T. */
  at: Date;
  /** Why the replay does not hold what the decision read at `path`; undefined when it does. */
  unheld(path: string): string | undefined;
}

export function replayContext(record: DecisionRecord): ReplayContext {
  const unknowable = new Set<string>();
  const inputs = record.inputs;
  const state = inputs?.principalState == null ? undefined : principalStateOf(inputs.principalState, unknowable);
  const principal = record.facts === undefined ? bare(record.principal, state) : factsOf(record.facts.principal, state);
  const at = new Date(record.at);
  const env = inputs === undefined ? {} : (fromCanonical(inputs.env, 'env', unknowable) as Record<string, unknown>);
  const scope = inputs === undefined ? {} : scopeOf(inputs.attributes, unknowable);
  const context: CaveatContext = { env: { ...env, now: at }, scope };
  const unheld = (path: string): string | undefined => {
    if ([...unknowable].some((u) => path === u || path.startsWith(`${u}.`) || u.startsWith(`${path}.`))) return 'the capture cannot reproduce the value (a bigint, a function, a cycle, or an instant held as a Date or a string)';
    const [root, head] = path.split('.');
    if (root === 'principal' || root === 'actor') return head === 'type' || head === 'id' || (head === 'attributes' && principal.attributes !== undefined) ? undefined : 'only the type, id and captured attributes of the principal are replayed';
    if (path === 'env.now') return undefined;
    return captured(root, head);
  };
  const captured = (root: string, head: string | undefined): string | undefined => {
    if (root === 'fn') return 'app condition functions are unknown at the decision instant';
    if (root === 'resource') return 'the resource row is not part of the captured inputs';
    if (inputs === undefined) return 'inputs are captured only with authz.decisionLog.captureInputs';
    if (root === 'env') return undefined;
    return root === 'scope' && head !== undefined && own(scope, head) ? undefined : `the decision read no ${head ?? ''} scope node`;
  };
  return { principal, context, at, unheld };
}

function bare(key: string, state: DecodedState | undefined): PrincipalFacts {
  const ref = parseResourceKey(key);
  return withState({ type: ref.type, id: ref.id ?? '' }, state);
}

function factsOf(f: PrincipalFactsRecord, state: DecodedState | undefined): PrincipalFacts {
  return withState(
    {
      type: f.type,
      id: f.id,
      ...(f.ceiling === undefined ? {} : { ceiling: f.ceiling }),
      ...(f.delegation === undefined ? {} : { delegation: f.delegation }),
      ...(f.onBehalfOf === undefined ? {} : { onBehalfOf: factsOf(f.onBehalfOf, state?.onBehalfOf) }),
    },
    state,
  );
}

// The state was hashed for the request's principal; it says nothing of another one.
const withState = (p: PrincipalFacts, state: DecodedState | undefined): PrincipalFacts => (state !== undefined && state.type === p.type && state.id === p.id ? { ...p, attributes: state.attributes } : p);

interface DecodedState {
  type: string;
  id: string;
  attributes: Record<string, unknown>;
  onBehalfOf?: DecodedState;
}

/** `principalState()` JSON: attribute values tagged `{ $undefined }`, `{ $date }`, and `$` keys escaped with one more `$`. */
function principalStateOf(text: string, unknowable: Set<string>): DecodedState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const decode = (s: unknown, path: string): DecodedState | undefined => {
    if (!isRecord(s) || typeof s.type !== 'string' || typeof s.id !== 'string' || !isRecord(s.attributes)) return undefined;
    const onBehalfOf = decode(s.onBehalfOf, path);
    const attributes = fromState(s.attributes, `${path}.attributes`, unknowable) as Record<string, unknown>;
    return { type: s.type, id: s.id, attributes, ...(onBehalfOf === undefined ? {} : { onBehalfOf }) };
  };
  return decode(parsed, 'principal');
}

function fromState(v: unknown, path: string, unknowable: Set<string>): unknown {
  if (Array.isArray(v)) return v.map((x) => fromState(x, path, unknowable));
  if (!isRecord(v)) return v;
  const keys = Object.keys(v);
  if (keys.length === 1 && keys[0] === '$undefined') return undefined;
  if (keys.length === 1 && keys[0] === '$date') {
    const time = typeof v.$date === 'string' ? Date.parse(v.$date) : NaN;
    if (!Number.isNaN(time)) return new Date(time);
    unknowable.add(path);
    return undefined;
  }
  return entriesOf(v, (k, x) => {
    const name = k.startsWith('$') ? k.slice(1) : k;
    return [name, fromState(x, `${path}.${name}`, unknowable)];
  });
}

/** `canonical()` JSON as the tap stores a capture: tags back to values where they hold one, else the path is unknowable. */
function fromCanonical(v: unknown, path: string, unknowable: Set<string>): unknown {
  if (Array.isArray(v)) return v.map((x) => fromCanonical(x, path, unknowable));
  if (isRecord(v)) return entriesOf(v, (k, x) => [k, fromCanonical(x, `${path}.${k}`, unknowable)]);
  if (typeof v !== 'string' || v === '<undefined>') return v === '<undefined>' ? undefined : v;
  const n = NUMBER_TAG.exec(v);
  if (n) return Number(n[1]);
  if (OPAQUE_TAG.test(v) || ISO_INSTANT.test(v)) unknowable.add(path);
  return v;
}

function scopeOf(attributes: ReadonlyArray<{ ref: unknown; value: unknown }>, unknowable: Set<string>): Record<string, Record<string, unknown>> {
  const scope = new Map<string, { id: unknown; value: Record<string, unknown> }>();
  for (const a of attributes) {
    if (!isRecord(a.ref) || typeof a.ref.type !== 'string' || !isRecord(a.value)) continue;
    const type = a.ref.type;
    const seen = scope.get(type);
    if (seen !== undefined && seen.id !== a.ref.id) unknowable.add(`scope.${type}`);
    scope.set(type, { id: a.ref.id, value: fromCanonical(a.value, `scope.${type}`, unknowable) as Record<string, unknown> });
  }
  return Object.fromEntries([...scope].map(([type, s]) => [type, s.value]));
}
