import assert from 'node:assert/strict';

import { principalKey } from '@spinajs/authz';
import type { Ceiling, Decision, Permission, Principal, PrincipalRef, PrincipalType, ResourceRef, ResourceType } from '@spinajs/authz';

import type { FakeRow } from '../fakes/index.js';
import { readPath } from '../util.js';
import { assertDecision, assertThrows, isThrows } from './expect.js';
import type { BehaviourAuthz, LaneHandles, StepContext } from './harness.js';
import type { DecisionExpectation, DoStep, RunAsStep, Step, Throws, Who } from './types.js';
import type { KitWorld } from './world.js';

// Lane fixtures: what a lane builds is data in `World.lane`, which the lane's harness
// materialises with the lane's own decorators and classes; the steps are `do` steps over the lane
// handles of `HarnessSession.lane`. Nothing here imports a lane package.

// ---------------------------------------------------------------------------------------------
// World data

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A BasePolicy built from data: it lets the request through, or rejects it with Forbidden (403). */
export interface TestPolicy {
  readonly name: string;
  readonly passes: boolean;
}

/** `fromParam(name, type)`, `fromBody(name, type)`, `fromQuery(name, type)` (design §11.2). */
export interface ResourceSource {
  readonly from: 'param' | 'body' | 'query';
  readonly name: string;
  readonly type: ResourceType;
}

/** `@Access(permission, opts)` (design §11.2). */
export interface AccessSpec {
  readonly permission: Permission | readonly Permission[];
  readonly resource?: ResourceSource;
  /** `also`: policies of the same group (AND). */
  readonly also?: readonly TestPolicy[];
  readonly domain?: string;
  readonly subject?: 'load' | 'none';
  readonly fields?: 'filter' | 'none';
}

/**
 * What the route's action answers (200):
 * - 'principal': `{ principal: { type, id } }` of `@CurrentPrincipal()`;
 * - 'echo': the request body as the action received it (after the input field filter);
 * - `returns`: the subject of that world row (`session.load(ref)`, else the world row), so the output field filter applies;
 * - `orm`: `{ ids }` of an ORM query run inside the request.
 */
export type RouteHandler = 'principal' | 'echo' | { readonly returns: ResourceRef } | { readonly orm: OrmQuery };

export interface RouteSpec {
  readonly method: HttpMethod;
  /** Express style, e.g. '/files/:id'. */
  readonly path: string;
  readonly access?: AccessSpec;
  /** `@AllowAnonymous()`. */
  readonly anonymous?: boolean;
  /** `@Unscoped(reason)`. */
  readonly unscoped?: string;
  /** Separate `@Policy(...)` groups, each OR with the `@Access` group. */
  readonly policies?: readonly TestPolicy[];
  /** `@Policy('<configuration key>')`: a policy slot named by configuration (C7). */
  readonly configPolicy?: string;
  /** Default 'principal'. */
  readonly handler?: RouteHandler;
}

export interface HttpWorld {
  /** The app environment (SpinaJS configuration `env`); default: not production. */
  readonly env?: 'production' | 'development' | 'test';
  readonly routes?: readonly RouteSpec[];
  /** App configuration outside `authz.*` (e.g. `telemetry.auth.*`), merged into the app's configuration. */
  readonly config?: Readonly<Record<string, unknown>>;
  /** Identity records (users rows) the app holds for world principals, by principal key. */
  readonly identities?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** `@OrmScope(model, relation)` with an `OrmScopePolicy` built from data. */
export interface OrmScopeSpec {
  readonly relation: string;
  /** `scope()`: rows whose `column` equals the principal's attribute `attribute`. */
  readonly column: string;
  readonly attribute: string;
  /** `authorizeCreate`: 'stamp' sets `column` to the principal's attribute; 'check' throws Forbidden (403) for an insert whose value differs. */
  readonly onCreate?: 'stamp' | 'check';
  /** `authorizeUpdate`: throws Forbidden (403) for values that set `column` to anything but the principal's attribute. */
  readonly guardUpdate?: boolean;
}

/** A many-to-many relation through a junction table. */
export interface OrmJunctionSpec {
  readonly name: string;
  readonly target: string;
  /** [this model's id, target id] pairs. */
  readonly pairs: readonly (readonly [string, string])[];
}

/** An ORM model; with `type` it carries `@AccessResource(type, { relationScope, attributes })`. Primary key `id` (string). */
export interface OrmModelSpec {
  readonly name: string;
  readonly type?: ResourceType;
  readonly relationScope?: 'where' | 'join';
  readonly attributes?: readonly string[];
  /** The `@Owner()` column. */
  readonly owner?: string;
  /** `@ScopeColumn(column, type)`, nearest ancestor first. */
  readonly scopeColumns?: readonly { readonly column: string; readonly type: ResourceType }[];
  readonly scopes?: readonly OrmScopeSpec[];
  /** Columns besides `id`. */
  readonly columns: readonly string[];
  /** Columns of `columns` that hold JSON; their row values are JSON text. */
  readonly json?: readonly string[];
  readonly rows?: readonly FakeRow[];
  readonly junctions?: readonly OrmJunctionSpec[];
  /** `@BelongsTo(target, column, 'id')` on the property `name` (RFC L4-1). */
  readonly belongsTo?: readonly { readonly name: string; readonly target: string; readonly column: string }[];
}

export interface OrmWorld {
  readonly models: readonly OrmModelSpec[];
}

/**
 * `model` names a model of `World.lane.orm` or one a lane package registers (`DbConfig`, `JobModel`).
 * A select's `populate` names a `belongsTo` relation of the model, populated into the query (RFC L4-1).
 */
export type OrmQuery = { readonly op: 'select'; readonly model: string; readonly where?: Readonly<Record<string, unknown>>; readonly clone?: boolean; readonly populate?: string } | { readonly op: 'related'; readonly model: string; readonly id: string; readonly relation: string } | { readonly op: 'insert'; readonly model: string; readonly values: Readonly<Record<string, unknown>> } | { readonly op: 'update'; readonly model: string; readonly where: Readonly<Record<string, unknown>>; readonly values: Readonly<Record<string, unknown>> } | { readonly op: 'delete'; readonly model: string; readonly where: Readonly<Record<string, unknown>> };

export interface FsProviderSpec {
  readonly name: string;
  /** Files present at setup: path → content. */
  readonly files?: Readonly<Record<string, string>>;
  /** Methods the provider has beyond the abstract `fs`, which no operation table maps. */
  readonly extraMethods?: readonly string[];
}

/** An `FsPathResolver`: a path `<prefix><id>/…` of `fs` has the domain parent `{ type, id }`. */
export interface FsResolverSpec {
  /** The class name `authz.fs.<name>.resolver` refers to. */
  readonly name: string;
  readonly fs: string;
  readonly prefix: string;
  readonly type: ResourceType;
}

export interface FsWorld {
  readonly providers: readonly FsProviderSpec[];
  readonly resolvers?: readonly FsResolverSpec[];
}

/** A `@Job(opts)` handler: it records `authz().current()` and checks each entry of `checks` as that principal. */
export interface JobSpec {
  readonly name: string;
  readonly runAs?: 'initiator' | 'system';
  readonly checks?: readonly { readonly permission: Permission; readonly resource?: ResourceRef }[];
}

/** A `JobModel` row (queue `jobs` table). */
export interface JobRecordSpec {
  readonly id: string;
  readonly job: string;
  readonly initiator?: PrincipalRef;
  /** queue's JobStatus. */
  readonly status?: 'created' | 'executing' | 'retrying' | 'success' | 'error' | 'dead';
}

export interface QueueWorld {
  readonly jobs?: readonly JobSpec[];
  readonly records?: readonly JobRecordSpec[];
}

/** `DbConfig` rows. */
export interface ConfigurationWorld {
  readonly rows: readonly { readonly path: string; readonly value: unknown }[];
}

/** http-socket handlers; no principal source is wired unless the lane adds one. */
export interface SocketWorld {
  readonly handlers: readonly { readonly event: string; readonly orm: OrmQuery }[];
}

/** What lanes build, as data. */
export interface LaneWorld {
  readonly http?: HttpWorld;
  readonly orm?: OrmWorld;
  readonly fs?: FsWorld;
  readonly queue?: QueueWorld;
  readonly configuration?: ConfigurationWorld;
  readonly socket?: SocketWorld;
}

declare module './types.js' {
  interface World {
    /** Lane data (routes, ORM models, filesystems, jobs, …); the lane's harness materialises it. */
    readonly lane?: LaneWorld;
  }
}

// ---------------------------------------------------------------------------------------------
// Lane handles (HarnessSession.lane), one per lane facet

export interface HttpRequest {
  readonly method: HttpMethod;
  /** With the query string when one is given. */
  readonly path: string;
  /** Whom the test principal source yields for the request; absent: no credential. */
  readonly principal?: Principal;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface LogRecord {
  readonly level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'security' | (string & {});
  readonly message: string;
  /** The record carries a decision Trace. */
  readonly trace: boolean;
}

/** http facet: requests against the app built from `World.lane.http`, and the log records it wrote since setup. */
export interface HttpHandle {
  request(req: HttpRequest): Promise<HttpResponse>;
  logs(): readonly LogRecord[];
}

export interface OrmResult {
  /** Primary keys of the rows a select or related query returned. */
  readonly ids?: readonly string[];
  /** Rows a select returned. */
  readonly count?: number;
  /** Every SQL statement the query executed, in order. */
  readonly sql: readonly string[];
  /** A select with `populate`: per row id it returned, the id of the populated target, null where the join found none. */
  readonly populated?: Readonly<Record<string, string | null>>;
}

/** orm facet: queries run in the current ALS (as `authz().current()`); `rows` reads a table raw, unscoped. */
export interface OrmHandle {
  run(q: OrmQuery): Promise<OrmResult>;
  rows(model: string): Promise<readonly Readonly<Record<string, unknown>>[]>;
}

/** `{ fs }`: that filesystem as `getFs` returns it; `{ localFile }`: a local file outside every fs holding this content. */
export type FsArg = string | number | null | readonly FsArg[] | { readonly fs: string } | { readonly localFile: string };

/** fs facet: methods of `getFs(name)` called in the current ALS; a stream result is drained or ended by the handle. */
export interface FsHandle {
  call(fs: string, method: string, args: readonly FsArg[]): Promise<unknown>;
  /** `getFs(name)` is the provider instance fsService created, not a guard. */
  isRaw(fs: string): boolean;
}

/** `message.Initiator` (authz-queue `Initiator`). */
export interface InitiatorStamp {
  readonly type: PrincipalType;
  readonly id: string;
  readonly ceiling?: Ceiling;
}

export interface QueueMessage {
  readonly Initiator?: InitiatorStamp;
  readonly [key: string]: unknown;
}

/** What a JobSpec handler saw. */
export interface JobRun {
  readonly principal: Principal;
  /** One per `JobSpec.checks` entry, in order. */
  readonly decisions: readonly Decision[];
}

/** A second app node over the same world and the same queue transport; `peer()` returns the same node for the whole case. */
export interface QueuePeer {
  readonly authz: BehaviourAuthz;
  readonly kit: KitWorld;
}

/** queue facet: `emit` through QueueService.emit in the current ALS; `handle` through the consumer (outside any ALS). */
export interface QueueHandle {
  emit(job: string, payload?: Readonly<Record<string, unknown>>): Promise<QueueMessage>;
  handle(message: QueueMessage): Promise<JobRun>;
  peer(): Promise<QueuePeer>;
}

/** `Scope` of an authn token: Ceiling fields plus `agent` (design §22.9). */
export interface TokenScope {
  readonly permissions?: readonly string[];
  readonly resources?: readonly ResourceRef[];
  readonly agent?: boolean;
}

export interface TokenRequest {
  readonly owner: Principal;
  readonly roles?: readonly string[];
  readonly scope?: TokenScope;
  /** Default: 'agent' when `scope.agent`, else 'pat'. */
  readonly kind?: 'pat' | 'agent' | 'service';
}

/** token facet: issues a token (TokenService.create) and returns the principal the app resolves for a request bearing it. */
export interface TokenHandle {
  principal(req: TokenRequest): Promise<Principal>;
}

export type AuthnFlow = { readonly kind: 'login' | 'mfa'; readonly as: Principal } | { readonly kind: 'roleSwitch'; readonly as: Principal; readonly role: string } | { readonly kind: 'impersonation'; readonly as: Principal; readonly target: Principal };

export interface AuthnResult {
  readonly status: number;
  readonly body: unknown;
  /** The principal the session yields after the flow. */
  readonly principal: Principal | null;
}

/** authn facet: authn-http flows (login, MFA completion, role switch, impersonation start) for world principals. */
export interface AuthnHandle {
  flow(f: AuthnFlow): Promise<AuthnResult>;
}

/** store facet: `authz_version(domain)`. */
export interface StoreHandle {
  version(domain: string): Promise<string>;
}

/** configuration facet: one configuration-db-source poll, and the configuration value it produced. */
export interface ConfigurationHandle {
  poll(): Promise<void>;
  value(path: string): unknown;
}

/** socket facet: emits an event to the `World.lane.socket` handler; resolves with its result, or rejects with the handler's error. */
export interface SocketHandle {
  emit(event: string, payload?: unknown): Promise<unknown>;
}

/** email facet: sends a mail in the current ALS; attachments are files of the named filesystems. Rejects with the error the send threw. */
export interface EmailHandle {
  send(mail: { readonly to: string; readonly attachments: readonly { readonly fs: string; readonly path: string }[] }): Promise<void>;
}

declare module './harness.js' {
  interface LaneHandles {
    http: HttpHandle;
    orm: OrmHandle;
    fs: FsHandle;
    queue: QueueHandle;
    token: TokenHandle;
    authn: AuthnHandle;
    store: StoreHandle;
    configuration: ConfigurationHandle;
    socket: SocketHandle;
    email: EmailHandle;
  }
}

// ---------------------------------------------------------------------------------------------
// Step helpers

export function laneHandle<K extends keyof LaneHandles>(ctx: StepContext, key: K): LaneHandles[K] {
  const h = ctx.session.lane?.[key];
  assert.ok(h, `the session has no lane handle "${String(key)}"`);
  return h as LaneHandles[K];
}

// Values one step hands to a later step of the same case; a session lives for exactly one case.
const STASH = new WeakMap<object, Map<string, unknown>>();

function stash(ctx: StepContext): Map<string, unknown> {
  let m = STASH.get(ctx.session);
  if (!m) STASH.set(ctx.session, (m = new Map()));
  return m;
}

function stashed<T>(ctx: StepContext, key: string): T {
  const m = stash(ctx);
  assert.ok(m.has(key), `no value "${key}" from an earlier step`);
  return m.get(key) as T;
}

/** The nested steps run under `authz.runAs(who, 'behaviour fixture')` (host facet). */
export const as = (who: Who, ...steps: Step[]): RunAsStep => ({ runAs: { as: who, reason: 'behaviour fixture' }, steps });

/** A thrown error; `reason`: the code of its `decision.reason` (AccessDenied). */
export type LaneThrows = Throws & { readonly reason?: string };

export function assertLaneThrows(e: unknown, t: LaneThrows, what: string): void {
  assertThrows(e, t, what);
  if (t.reason !== undefined) assert.equal((e as { decision?: Decision }).decision?.reason?.code, t.reason, `${what}: decision.reason.code`);
}

async function settle<T>(fn: () => Promise<T>, expect: unknown, what: string): Promise<{ readonly threw: true } | { readonly threw: false; readonly value: T }> {
  let value: T;
  try {
    value = await fn();
  } catch (e) {
    if (!isThrows(expect)) throw e;
    assertLaneThrows(e, expect as LaneThrows, what);
    return { threw: true };
  }
  if (isThrows(expect)) assert.fail(`${what}: expected a throw of ${expect.throws}, got ${short(value)}`);
  return { threw: false, value };
}

const short = (v: unknown): string => {
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > 300 ? `${s.slice(0, 299)}…` : s;
};

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * `expected` is a pattern: an object matches when each of its keys matches; an array matches when each
 * of its elements matches some element of the actual array (any order, extra elements allowed); any
 * other value must be deep-equal.
 */
export function matches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((e) => actual.some((a) => matches(a, e)));
  if (isObject(expected)) return isObject(actual) && Object.entries(expected).every(([k, v]) => Object.hasOwn(actual, k) && matches(actual[k], v));
  try {
    assert.deepEqual(actual, expected);
    return true;
  } catch {
    return false;
  }
}

export function assertMatches(actual: unknown, expected: unknown, what: string): void {
  assert.ok(matches(actual, expected), `${what}: ${short(actual)} does not match ${short(expected)}`);
}

/** Each dotted path is absent from `body`. */
export function assertAbsent(body: unknown, paths: readonly string[], what: string): void {
  for (const p of paths) {
    const parent = p.includes('.') ? readPath(body, p.slice(0, p.lastIndexOf('.'))) : body;
    const key = p.slice(p.lastIndexOf('.') + 1);
    assert.ok(!(isObject(parent) && Object.hasOwn(parent, key)), `${what}: ${p} is present in ${short(body)}`);
  }
}

// --- http ---------------------------------------------------------------------------------------

export interface HttpExpectation {
  /** A status, any of several, or anything but one. */
  readonly status: number | readonly number[] | { readonly not: number };
  /** A pattern (see {@link matches}) the body matches. */
  readonly body?: unknown;
  /** Dotted paths absent from the body. */
  readonly absent?: readonly string[];
  /** No element of the array at `at` (a dotted path; '' = the body) matches `match`. */
  readonly none?: readonly { readonly at: string; readonly match: unknown }[];
}

export interface HttpCall {
  readonly method: HttpMethod;
  readonly path: string;
  /** Absent: no credential (an anonymous request). */
  readonly as?: Who;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export function assertResponse(res: HttpResponse, e: HttpExpectation, what: string): void {
  const s = e.status;
  if (typeof s === 'number') assert.equal(res.status, s, `${what}: status ${res.status}, body ${short(res.body)}`);
  else if (Array.isArray(s)) assert.ok(s.includes(res.status), `${what}: status ${res.status} is none of ${s.join(', ')}; body ${short(res.body)}`);
  else assert.notEqual(res.status, (s as { not: number }).not, `${what}: status ${res.status}`);
  if (e.body !== undefined) assertMatches(res.body, e.body, `${what}: body`);
  if (e.absent) assertAbsent(res.body, e.absent, `${what}: body`);
  for (const n of e.none ?? []) {
    const list = n.at === '' ? res.body : readPath(res.body, n.at);
    assert.ok(Array.isArray(list), `${what}: ${n.at || 'the body'} is not an array in ${short(res.body)}`);
    assert.ok(!list.some((x) => matches(x, n.match)), `${what}: ${n.at || 'the body'} has an element matching ${short(n.match)}`);
  }
}

async function send(ctx: StepContext, call: HttpCall, principal?: Principal): Promise<HttpResponse> {
  const who = principal ?? (call.as === undefined ? undefined : ctx.principal(call.as));
  return laneHandle(ctx, 'http').request({ method: call.method, path: call.path, ...(who ? { principal: who } : {}), ...(call.body !== undefined ? { body: call.body } : {}), ...(call.headers ? { headers: call.headers } : {}) });
}

const describeWho = (w: Who | undefined): string => (w === undefined ? 'anonymously' : `as ${typeof w === 'string' ? w : principalKey(w)}`);

export const http = (call: HttpCall, expect: HttpExpectation): DoStep => {
  const note = `${call.method} ${call.path} ${describeWho(call.as)}`;
  return { note, do: async (ctx) => assertResponse(await send(ctx, call), expect, note) };
};

/** http: some log record at debug level carries a trace, and no record at another level does. */
export const tracesOnlyAtDebug = (): DoStep => ({
  note: 'traces in the log',
  do: (ctx) => {
    const logs = laneHandle(ctx, 'http').logs();
    assert.ok(
      logs.some((l) => l.trace && l.level === 'debug'),
      'no debug log record carries a trace',
    );
    const elsewhere = logs.filter((l) => l.trace && l.level !== 'debug');
    assert.deepEqual(
      elsewhere.map((l) => `${l.level}: ${l.message}`),
      [],
      'log records above debug carry a trace',
    );
  },
});

// --- orm ----------------------------------------------------------------------------------------

export interface OrmExpectation {
  /** Exactly these ids, any order. */
  readonly ids?: readonly string[];
  readonly count?: number;
  /** Some executed statement has (true) or none has (false) a WHERE clause. */
  readonly where?: boolean;
  /** Exactly `OrmResult.populated` (RFC L4-1). */
  readonly populated?: Readonly<Record<string, string | null>>;
}

const WHERE = /\bwhere\b/i;

export const orm = (q: OrmQuery, expect: OrmExpectation | LaneThrows): DoStep => {
  const note = `orm ${q.op} ${q.model}${'where' in q && q.where ? ` ${short(q.where)}` : ''}${'id' in q ? ` ${q.id}.${q.relation}` : ''}${'populate' in q && q.populate ? ` populate ${q.populate}` : ''}`;
  return {
    note,
    do: async (ctx) => {
      const res = await settle(() => laneHandle(ctx, 'orm').run(q), expect, note);
      if (res.threw) return;
      const e = expect as OrmExpectation;
      if (e.ids) assert.deepEqual([...(res.value.ids ?? [])].sort(), [...e.ids].sort(), `${note}: ids`);
      if (e.count !== undefined) assert.equal(res.value.count, e.count, `${note}: count`);
      if (e.where !== undefined)
        assert.equal(
          res.value.sql.some((s) => WHERE.test(s)),
          e.where,
          `${note}: WHERE in ${short(res.value.sql)}`,
        );
      if (e.populated !== undefined) assert.deepEqual(res.value.populated, e.populated, `${note}: populated`);
    },
  };
};

export interface RowsExpectation {
  /** Exactly these ids are in the table. */
  readonly ids?: readonly string[];
  /** Each pattern names an `id`; the row with that id matches it. */
  readonly rows?: readonly ({ readonly id: string } & Readonly<Record<string, unknown>>)[];
}

/** The raw table of `model` (unscoped). */
export const ormRows = (model: string, expect: RowsExpectation): DoStep => {
  const note = `rows of ${model}`;
  return {
    note,
    do: async (ctx) => {
      const rows = await laneHandle(ctx, 'orm').rows(model);
      if (expect.ids) assert.deepEqual(rows.map((r) => String(r.id)).sort(), [...expect.ids].sort(), `${note}: ids`);
      for (const want of expect.rows ?? []) {
        const row = rows.find((r) => String(r.id) === want.id);
        assert.ok(row, `${note}: no row ${want.id}`);
        assertMatches(row, want, `${note}: row ${want.id}`);
      }
    },
  };
};

/** A lane call that resolves, or throws as expected. */
export const laneCall = (note: string, fn: (ctx: StepContext) => Promise<unknown>, expect: 'resolves' | LaneThrows): DoStep => ({ note, do: async (ctx) => void (await settle(() => fn(ctx), expect === 'resolves' ? undefined : expect, note)) });

// --- fs -----------------------------------------------------------------------------------------

export const fsCall = (fs: string, method: string, args: readonly FsArg[], expect: 'resolves' | LaneThrows): DoStep => laneCall(`${fs}.${method}(${args.map((a) => short(a)).join(', ')})`, (ctx) => laneHandle(ctx, 'fs').call(fs, method, args), expect);

export const fsRaw = (fs: string, raw: boolean): DoStep => ({ note: `getFs(${fs}) is ${raw ? '' : 'not '}the raw provider`, do: (ctx) => assert.equal(laneHandle(ctx, 'fs').isRaw(fs), raw, `getFs(${fs}) raw`) });

// --- queue --------------------------------------------------------------------------------------

/** Emits `job` in the current ALS and keeps the message as `key` for {@link handled}. `initiator` null: no Initiator. */
export const emitted = (key: string, job: string, initiator?: (Readonly<Record<string, unknown>> & { readonly type: string; readonly id: string }) | null): DoStep => ({
  note: `emit ${job}`,
  do: async (ctx) => {
    const message = await laneHandle(ctx, 'queue').emit(job);
    stash(ctx).set(key, message);
    if (initiator === null) assert.equal(message.Initiator, undefined, `emit ${job}: Initiator ${short(message.Initiator)}`);
    else if (initiator) assertMatches(message.Initiator, initiator, `emit ${job}: Initiator`);
  },
});

export interface JobExpectation {
  /** The handler's principal by type and id ('system', 'unattended' included). */
  readonly principal: PrincipalRef;
  /** A pattern for the principal's ceiling; null: no ceiling. */
  readonly ceiling?: Readonly<Record<string, unknown>> | null;
  /** One per JobSpec check, in order. */
  readonly decisions?: readonly DecisionExpectation[];
}

/** Runs the message kept as `key` through the consumer. */
export const handled = (key: string, expect: JobExpectation): DoStep => ({
  note: `handle ${key}`,
  do: async (ctx) => {
    const run = await laneHandle(ctx, 'queue').handle(stashed<QueueMessage>(ctx, key));
    assert.equal(principalKey(run.principal), principalKey(expect.principal), `handle ${key}: principal`);
    if (expect.ceiling === null) assert.equal(run.principal.ceiling, undefined, `handle ${key}: ceiling`);
    else if (expect.ceiling) assertMatches(run.principal.ceiling, expect.ceiling, `handle ${key}: ceiling`);
    (expect.decisions ?? []).forEach((d, i) => {
      assert.ok(run.decisions[i], `handle ${key}: no decision ${i}`);
      assertDecision(run.decisions[i], d, `handle ${key}: decision ${i}`);
    });
  },
});

/**
 * Waits (polling) until `fn` stops throwing; gives up after `timeoutMs` (default 10 s).
 * A harness on slow CI can pass a longer one if its step takes an option.
 */
export async function eventually(fn: () => void | Promise<void>, timeoutMs = 10_000, everyMs = 10): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fn();
      return;
    } catch (e) {
      if (Date.now() >= until) throw e;
      await new Promise((r) => setTimeout(r, everyMs));
    }
  }
}

// --- principals made at run time (token, authn) ---------------------------------------------------

/** A principal made at run time: a token principal, or the principal after an authn flow. */
export interface TokenPrincipalExpectation {
  readonly type?: PrincipalType;
  readonly id?: string;
  readonly onBehalfOf?: PrincipalRef;
  readonly delegation?: 'intersect' | 'inherit';
  /** A pattern for the ceiling. */
  readonly ceiling?: Readonly<Record<string, unknown>>;
  /** The ceiling has exactly these keys (with a defined value). */
  readonly ceilingKeys?: readonly string[];
}

export function assertPrincipal(p: Principal, e: TokenPrincipalExpectation, what: string): void {
  if (e.type !== undefined) assert.equal(p.type, e.type, `${what}: type`);
  if (e.id !== undefined) assert.equal(p.id, e.id, `${what}: id`);
  if (e.onBehalfOf) {
    assert.ok(p.onBehalfOf, `${what}: no onBehalfOf`);
    assert.equal(principalKey(p.onBehalfOf), principalKey(e.onBehalfOf), `${what}: onBehalfOf`);
  }
  if (e.delegation !== undefined) assert.equal(p.delegation, e.delegation, `${what}: delegation`);
  if (e.ceiling) assertMatches(p.ceiling, e.ceiling, `${what}: ceiling`);
  if (e.ceilingKeys) {
    const keys = Object.entries(p.ceiling ?? {})
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k);
    assert.deepEqual(keys.sort(), [...e.ceilingKeys].sort(), `${what}: ceiling keys of ${short(p.ceiling)}`);
  }
}

export interface TokenCall {
  readonly owner: Who;
  readonly roles?: readonly string[];
  readonly scope?: TokenScope;
  /** Default: 'agent' when `scope.agent`, else 'pat'. */
  readonly kind?: 'pat' | 'agent' | 'service';
}

/** Issues a token and keeps the principal the app resolves for it as `key`. */
export const token = (key: string, call: TokenCall, expect: TokenPrincipalExpectation = {}): DoStep => ({
  note: `token ${key}`,
  do: async (ctx) => {
    const p = await laneHandle(ctx, 'token').principal({ owner: ctx.principal(call.owner), ...(call.roles ? { roles: call.roles } : {}), ...(call.scope ? { scope: call.scope } : {}), ...(call.kind ? { kind: call.kind } : {}) });
    stash(ctx).set(key, p);
    assertPrincipal(p, expect, `token ${key}`);
  },
});

export type FlowCall = { readonly kind: 'login' | 'mfa'; readonly as: Who } | { readonly kind: 'roleSwitch'; readonly as: Who; readonly role: string } | { readonly kind: 'impersonation'; readonly as: Who; readonly target: Who };

/** Runs an authn flow and keeps its result as `key`. */
export const flow = (key: string, call: FlowCall, expect: { readonly status?: number; readonly principal?: TokenPrincipalExpectation } = {}): DoStep => ({
  note: `${call.kind} ${key}`,
  do: async (ctx) => {
    const f: AuthnFlow = call.kind === 'roleSwitch' ? { kind: 'roleSwitch', as: ctx.principal(call.as), role: call.role } : call.kind === 'impersonation' ? { kind: 'impersonation', as: ctx.principal(call.as), target: ctx.principal(call.target) } : { kind: call.kind, as: ctx.principal(call.as) };
    const res = await laneHandle(ctx, 'authn').flow(f);
    stash(ctx).set(key, res);
    if (expect.status !== undefined) assert.equal(res.status, expect.status, `${call.kind}: status, body ${short(res.body)}`);
    if (expect.principal) {
      assert.ok(res.principal, `${call.kind}: no principal after the flow`);
      assertPrincipal(res.principal, expect.principal, call.kind);
    }
  },
});

/** The principal kept as `key` (a token principal, or the principal after an authn flow). */
function keptPrincipal(ctx: StepContext, key: string): Principal {
  const v = stashed<Principal | AuthnResult>(ctx, key);
  if ('body' in v && 'status' in v) {
    assert.ok(v.principal, `${key}: the flow yielded no principal`);
    return v.principal;
  }
  return v as Principal;
}

/** `authz.check` with the principal kept as `key`. */
export const checkKept = (key: string, req: { readonly permission: Permission; readonly resource?: ResourceRef }, expect: DecisionExpectation): DoStep => ({
  note: `check ${key} ${req.permission}`,
  do: async (ctx) => {
    const principal = keptPrincipal(ctx, key);
    const d = await ctx.authz().check({ principal, permission: req.permission, ...(req.resource ? { resource: req.resource } : {}) });
    assertDecision(d, expect, `check ${key} ${req.permission}`);
  },
});

/** The decision's actor is the principal kept as `key`. */
export const actorIsKept = (key: string, req: { readonly permission: Permission; readonly resource?: ResourceRef }): DoStep => ({
  note: `actor of ${key}`,
  do: async (ctx) => {
    const principal = keptPrincipal(ctx, key);
    const d = await ctx.authz().check({ principal, permission: req.permission, ...(req.resource ? { resource: req.resource } : {}) });
    assert.ok(d.actor, `actor of ${key}: none`);
    assert.equal(principalKey(d.actor), principalKey(principal), `actor of ${key}`);
  },
});

/** `GET /user/access` as the principal after the flow kept as `key` answers exactly the flow body's `Access`. */
export const accessOfFlow = (key: string): DoStep => ({
  note: `Access of ${key}`,
  do: async (ctx) => {
    const res = stashed<AuthnResult>(ctx, key);
    assert.ok(res.principal, `${key}: the flow yielded no principal`);
    const access = readPath(res.body, 'Access');
    assert.ok(access !== undefined, `${key}: the response has no Access: ${short(res.body)}`);
    const own = await send(ctx, { method: 'GET', path: '/user/access' }, res.principal);
    assert.equal(own.status, 200, `GET /user/access after ${key}`);
    assert.deepEqual(access, own.body, `${key}: Access differs from GET /user/access`);
  },
});

// --- store --------------------------------------------------------------------------------------

const storeDomain = (ctx: StepContext, domain: string | undefined): string => domain ?? ctx.domain;

/**
 * Keeps `authz_version(domain)` as `key`. The default domain is the runner's root domain
 * (`session.domain`, else `harness.domain`, else 'root').
 */
export const versionAs = (key: string, domain?: string): DoStep => ({
  note: `authz_version(${domain ?? '$domain'})`,
  do: async (ctx) => void stash(ctx).set(key, await laneHandle(ctx, 'store').version(storeDomain(ctx, domain))),
});

/** `authz_version(domain)` changed (or not) since {@link versionAs} kept it as `key`; the same default domain. */
export const versionChanged = (key: string, changed: boolean, domain?: string): DoStep => ({
  note: `authz_version(${domain ?? '$domain'}) ${changed ? 'changed' : 'unchanged'}`,
  do: async (ctx) => {
    const d = storeDomain(ctx, domain);
    const before = stashed<string>(ctx, key);
    const now = await laneHandle(ctx, 'store').version(d);
    if (changed) assert.notEqual(now, before, `authz_version(${d}) stayed ${before}`);
    else assert.equal(now, before, `authz_version(${d})`);
  },
});
