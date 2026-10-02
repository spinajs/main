import assert from 'node:assert/strict';

import { SYSTEM } from '@spinajs/authz';
import type { Assignment, AuthzAdminOptions, AuthzAdminQuery, AuthzCommand, AuthzCommandResult, AuthzEvent, Permission, Principal, PrincipalRef, ResourceRef, ResourceType } from '@spinajs/authz';

import { FakeScopeResolver } from '../fakes/index.js';
import { assertDecision } from './expect.js';
import type { HarnessSession, StepContext } from './harness.js';
import { laneHandle } from './lane.js';
import type { DecisionExpectation, DoStep, Who } from './types.js';

// The runner has no step kinds for AuthzAdmin, link tokens or raw store rows, so the model, store and
// admin fixtures express them as `do` steps built here; each one fails with a message naming the
// handle it misses.

/**
 * links facet: the principal the lane's link resolution yields for a bearer token, as
 * `LinkPrincipalSource` would build it (LinkStore.byToken, then RbacService.linkPrincipal(id,
 * companion)). An unknown token yields the principal of an unknown link (design §6.1.6); its id may
 * be anything, the fixtures read only its type and ceiling.
 */
export interface RbacLinksHandle {
  principal(token: string, companion?: Principal): Promise<Principal>;
}

/**
 * store facet: writes rows as the DB holds them, around AuthzAdmin's validation (a row left over
 * after its role left the config), and reads the raw `authz_link` rows. lane.ts's `store` handle
 * reads `authz_version` only.
 */
export interface RbacStoreHandle {
  insertAssignment(a: Assignment): Promise<void>;
  linkRows(): Promise<readonly Readonly<Record<string, unknown>>[]>;
}

/** admin facet: every AuthzEvent the domain's AuthzEventSinks received, in order. */
export interface AdminEventsHandle {
  readonly events: readonly AuthzEvent[];
}

/**
 * http facet (C4): the authz-http-admin routes of design §6.6.5 as `actor` (undefined: a request
 * without credentials). `results`/`items` are what the route answered, mapped back to the AuthzAdmin
 * shapes; `status` is the HTTP status. lane.ts's `http.request` sends raw requests; a C4 harness may
 * build this handle on it, adding the mapping of the response body to AuthzCommandResult.
 */
export interface AdminHttpHandle {
  execute(actor: Principal | undefined, body: { readonly commands: readonly AuthzCommand[] } & AuthzAdminOptions): Promise<{ readonly status: number; readonly results?: readonly AuthzCommandResult[] }>;
  list(actor: Principal | undefined, q: AuthzAdminQuery): Promise<{ readonly status: number; readonly items?: readonly unknown[] }>;
}

/**
 * impersonation facet (C3): users' AuthzImpersonationGuard (authn's ImpersonationGuard.allowed),
 * asked directly. lane.ts's `authn` handle (authn facet, D-F5-10) runs the whole impersonation flow
 * over HTTP; this one answers whether the guard allows it, with the refusal code.
 */
export interface ImpersonationGuardHandle {
  allowed(actor: Principal, target: PrincipalRef): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string }>;
}

/**
 * http facet (L5): the principal PrincipalMiddleware leaves in `req.storage.Principal` for a request
 * carrying a link token in the query parameter, header or cookie that `authz.http.links` names, after
 * a session source yielded `session` (if given); null when no source yields one. An L5 harness may
 * build it on lane.ts's `http.request` to a route with the 'principal' handler, placing the token as
 * `in` says.
 */
export interface LinkSourceHandle {
  principal(req: { readonly token: string; readonly in: 'query' | 'header' | 'cookie'; readonly session?: Principal }): Promise<Principal | null>;
}

/**
 * sql facet (L4b): one page of a list on the type, run as one SQL statement, in a stable order (by
 * primary key, say) that every page of one list shares.
 */
export interface SqlPagesHandle {
  page(principal: Principal, permission: Permission, type: ResourceType, page: { readonly limit: number; readonly offset: number }): Promise<readonly string[]>;
}

declare module './harness.js' {
  interface LaneHandles {
    rbacLinks: RbacLinksHandle;
    rbacStore: RbacStoreHandle;
    adminEvents: AdminEventsHandle;
    adminHttp: AdminHttpHandle;
    impersonationGuard: ImpersonationGuardHandle;
    linkSource: LinkSourceHandle;
    sqlPages: SqlPagesHandle;
  }
}

const VARS = new WeakMap<HarnessSession, Map<string, unknown>>();

function vars(ctx: StepContext): Map<string, unknown> {
  let m = VARS.get(ctx.session);
  if (!m) VARS.set(ctx.session, (m = new Map()));
  return m;
}

function saved(ctx: StepContext, name: string): readonly AuthzCommandResult[] {
  const v = vars(ctx).get(name);
  assert.ok(Array.isArray(v), `no results saved as "${name}" by an earlier step`);
  return v as readonly AuthzCommandResult[];
}

/** The results an earlier `exec` saved under a name. */
export type Saved = (name: string) => readonly AuthzCommandResult[];

/** The id (or token) of the result `index` of the results saved as `name`. */
export const savedId = (s: Saved, name: string, index = 0): string => {
  const r = s(name)[index];
  assert.ok(r?.ok && r.id, `results "${name}"[${index}] carry no id`);
  return r.id;
};

/** 'admin': the session's AuthzAdmin; 'http': the authz-http-admin routes (lane handle adminHttp). */
export type Via = 'admin' | 'http';

/** 'ok': every command succeeded. `failsAt`: the batch failed, and the result at that index says why. */
export type AdminOutcome = 'ok' | { readonly failsAt: number; readonly code?: string };

export interface ExecOptions extends AuthzAdminOptions {
  readonly via?: Via;
  /** Keeps the results for later steps. */
  readonly save?: string;
  /** The results deep-equal those saved under this name (a retried batch). */
  readonly sameAs?: string;
}

async function execute(ctx: StepContext, via: Via, actor: Principal | undefined, commands: readonly AuthzCommand[], options: AuthzAdminOptions): Promise<readonly AuthzCommandResult[]> {
  if (via === 'http') {
    const res = await laneHandle(ctx, 'adminHttp').execute(actor, { commands, ...options });
    assert.ok(res.results, `POST /authz/commands answered ${res.status} without command results`);
    return res.results;
  }
  assert.ok(ctx.session.admin, 'the session has no admin handle');
  assert.ok(actor, 'AuthzAdmin.execute needs an actor');
  return ctx.session.admin.execute(actor, commands, options);
}

function checkOutcome(results: readonly AuthzCommandResult[], commands: readonly AuthzCommand[], outcome: AdminOutcome, what: string): void {
  const all = JSON.stringify(results);
  results.forEach((r, i) => {
    if (commands[i]) assert.equal(r.kind, commands[i].kind, `${what}: result ${i} answers another command kind: ${all}`);
  });
  if (outcome === 'ok') {
    assert.equal(results.length, commands.length, `${what}: ${commands.length} results expected, got ${all}`);
    results.forEach((r, i) => assert.ok(r.ok, `${what}: command ${i} failed: ${JSON.stringify(r)}`));
    return;
  }
  // The batch reports its first failure (design §6.6.1), so no command before it may have failed.
  results.slice(0, outcome.failsAt).forEach((r, i) => assert.ok(r.ok, `${what}: command ${i} failed before command ${outcome.failsAt}: ${all}`));
  const r = results[outcome.failsAt];
  assert.ok(r && !r.ok, `${what}: command ${outcome.failsAt} was expected to fail, got ${all}`);
  if (outcome.code !== undefined) assert.equal(r.error.code, outcome.code, `${what}: error of command ${outcome.failsAt}: ${JSON.stringify(r.error)}`);
}

/**
 * `AuthzAdmin.execute(as, commands, opts)`, or POST /authz/commands with `via: 'http'`; checks the
 * outcome (kinds, first failure, error code) and can keep the results for later steps.
 */
export function exec(as: Who | undefined, commands: readonly AuthzCommand[] | ((s: Saved) => readonly AuthzCommand[]), outcome: AdminOutcome, opts: ExecOptions = {}): DoStep {
  const { via = 'admin', save, sameAs, ...options } = opts;
  const kinds = typeof commands === 'function' ? 'commands from saved results' : commands.map((c) => c.kind).join(', ');
  return {
    note: `execute [${kinds}]${via === 'http' ? ' over HTTP' : ''}`,
    do: async (ctx) => {
      const list = typeof commands === 'function' ? commands((n) => saved(ctx, n)) : commands;
      const results = await execute(ctx, via, as === undefined ? undefined : ctx.principal(as), list, options);
      checkOutcome(results, list, outcome, 'execute');
      if (save) vars(ctx).set(save, results);
      if (sameAs) assert.deepEqual(results, saved(ctx, sameAs), `the retried batch answers like the first (${sameAs})`);
    },
  };
}

/** POST /authz/commands is refused with `status` before any command runs. */
export function httpRefuses(as: Who | undefined, commands: readonly AuthzCommand[], status: number): DoStep {
  return {
    note: `POST /authz/commands answers ${status}`,
    do: async (ctx) => {
      const res = await laneHandle(ctx, 'adminHttp').execute(as === undefined ? undefined : ctx.principal(as), { commands });
      assert.equal(res.status, status, `status of POST /authz/commands: ${JSON.stringify(res)}`);
    },
  };
}

/** How a `do` step gets its principal: a world principal, a link token, or a token an earlier step saved. */
export type PrincipalSource = (ctx: StepContext) => Promise<Principal>;

export const who =
  (w: Who): PrincipalSource =>
  async (ctx) =>
    ctx.principal(w);

/** The link principal of a token (lane handle rbacLinks), with the companion given. */
export const viaLink =
  (token: string, companion?: Who): PrincipalSource =>
  async (ctx) =>
    laneHandle(ctx, 'rbacLinks').principal(token, companion === undefined ? undefined : ctx.principal(companion));

/** The link principal of the token in result `index` of the results saved as `name`. */
export const viaSavedLink =
  (name: string, index = 0, companion?: Who): PrincipalSource =>
  async (ctx) => {
    const token = saved(ctx, name)[index];
    assert.ok(token?.ok && typeof token.token === 'string', `results "${name}"[${index}] carry no token`);
    return laneHandle(ctx, 'rbacLinks').principal(token.token, companion === undefined ? undefined : ctx.principal(companion));
  };

export interface CheckSpec {
  readonly permission: Permission;
  readonly resource?: ResourceRef;
  readonly subject?: 'row' | object;
  readonly expect: DecisionExpectation;
}

/** `authz.check` for each spec, as the principal the source yields. */
export function checks(source: PrincipalSource, specs: readonly CheckSpec[], note = 'checks'): DoStep {
  return {
    note,
    do: async (ctx) => {
      const principal = await source(ctx);
      for (const s of specs) {
        const what = `check ${s.permission}${s.resource ? ` on ${s.resource.type}:${s.resource.id ?? ''}` : ''}`;
        const subject = s.subject === 'row' ? await ctx.subject(s.resource ?? { type: '' }) : s.subject;
        const d = await ctx.authz().check({ principal, permission: s.permission, ...(s.resource ? { resource: s.resource } : {}), ...(subject !== undefined ? { subject } : {}) });
        const selects = assertDecision(d, s.expect, what);
        if (selects) assert.deepEqual([...(await ctx.select(d.residual, d.resource.type, principal))].sort(), [...selects].sort(), `${what}: rows selected`);
      }
    },
  };
}

export interface PrincipalExpectation {
  readonly type?: string;
  readonly id?: string;
  readonly ceiling?: { readonly resources?: readonly ResourceRef[]; readonly expiresAt?: Date | null; readonly reason?: string };
  /** Exactly these companions (any order). */
  readonly companions?: readonly Who[];
}

function assertPrincipal(ctx: StepContext, p: Principal | null, e: PrincipalExpectation, what: string): void {
  assert.ok(p, `${what}: no principal`);
  if (e.type !== undefined) assert.equal(p.type, e.type, `${what}: type`);
  if (e.id !== undefined) assert.equal(p.id, e.id, `${what}: id`);
  if (e.ceiling) {
    assert.ok(p.ceiling, `${what}: no ceiling`);
    if (e.ceiling.resources)
      assert.deepEqual(
        p.ceiling.resources?.map((r) => ({ type: r.type, id: r.id })),
        e.ceiling.resources.map((r) => ({ type: r.type, id: r.id })),
        `${what}: ceiling.resources`,
      );
    if (e.ceiling.expiresAt !== undefined) assert.equal(p.ceiling.expiresAt?.getTime(), e.ceiling.expiresAt?.getTime(), `${what}: ceiling.expiresAt`);
    if (e.ceiling.reason !== undefined) assert.equal(p.ceiling.reason, e.ceiling.reason, `${what}: ceiling.reason`);
  }
  if (e.companions) {
    const want = e.companions.map((c) => ctx.principal(c)).map((c) => `${c.type}:${c.id}`);
    assert.deepEqual([...(p.companions ?? []).map((c) => `${c.type}:${c.id}`)].sort(), [...want].sort(), `${what}: companions`);
  }
}

/** The principal the source yields has these fields. */
export function principalIs(source: PrincipalSource, e: PrincipalExpectation, note = 'principal'): DoStep {
  return { note, do: async (ctx) => assertPrincipal(ctx, await source(ctx), e, note) };
}

/** What PrincipalMiddleware leaves for a request with a link token (lane handle linkSource); null: no link principal. */
export function requestPrincipal(req: { readonly token: string; readonly in: 'query' | 'header' | 'cookie'; readonly session?: Who }, e: PrincipalExpectation | 'not a link'): DoStep {
  return {
    note: `request with the link token in the ${req.in}`,
    do: async (ctx) => {
      const p = await laneHandle(ctx, 'linkSource').principal({ token: req.token, in: req.in, ...(req.session !== undefined ? { session: ctx.principal(req.session) } : {}) });
      if (e === 'not a link') assert.ok(p === null || p.type !== 'link', `the request yields ${JSON.stringify(p)}`);
      else assertPrincipal(ctx, p, e, 'request principal');
    },
  };
}

/** Counts from here on, for `since`. */
export function mark(name: string): DoStep {
  return {
    note: `mark ${name}`,
    do: (ctx) => {
      vars(ctx).set(`mark:${name}`, { published: ctx.session.bus?.published?.length ?? 0, audit: ctx.session.audit?.entries.length ?? 0, events: ctx.session.lane?.adminEvents?.events.length ?? 0 });
    },
  };
}

export interface SinceExpectation {
  /** Published AuthzChanges. */
  readonly published?: number;
  /** Audit entries of kind 'admin'. */
  readonly adminAudit?: number;
  /** AuthzEvents (lane handle adminEvents); `atLeast` for "some". */
  readonly events?: number | { readonly atLeast: number };
}

/** What happened after `mark(name)`. */
export function since(name: string, e: SinceExpectation): DoStep {
  return {
    note: `since ${name}`,
    do: (ctx) => {
      const m = vars(ctx).get(`mark:${name}`) as { published: number; audit: number; events: number } | undefined;
      assert.ok(m, `no mark ${name}`);
      if (e.published !== undefined) {
        const published = ctx.session.bus?.published;
        assert.ok(published, 'the session bus does not record published changes');
        assert.equal(published.length - m.published, e.published, `AuthzChanges published since ${name}: ${JSON.stringify(published.slice(m.published))}`);
      }
      if (e.adminAudit !== undefined) {
        assert.ok(ctx.session.audit, 'the session has no audit handle');
        const admin = ctx.session.audit.entries.slice(m.audit).filter((x) => x.kind === 'admin');
        assert.equal(admin.length, e.adminAudit, `admin audit entries since ${name}: ${JSON.stringify(admin)}`);
      }
      if (e.events !== undefined) {
        const events = laneHandle(ctx, 'adminEvents').events.slice(m.events);
        if (typeof e.events === 'number') assert.equal(events.length, e.events, `AuthzEvents since ${name}`);
        else assert.ok(events.length >= e.events.atLeast, `AuthzEvents since ${name}: ${events.length} < ${e.events.atLeast}`);
      }
    },
  };
}

export interface EventExpectation {
  readonly type: string;
  readonly actor?: Who;
  /** Keys of `data` deep-equal these. */
  readonly data?: Readonly<Record<string, unknown>>;
}

/** Since `mark(name)` the AuthzEventSinks received an event matching `e` (lane handle adminEvents). */
export function eventSince(name: string, e: EventExpectation): DoStep {
  return {
    note: `event ${e.type} since ${name}`,
    do: (ctx) => {
      const m = vars(ctx).get(`mark:${name}`) as { events: number } | undefined;
      assert.ok(m, `no mark ${name}`);
      const events = laneHandle(ctx, 'adminEvents').events.slice(m.events);
      const actor = e.actor === undefined ? undefined : ctx.principal(e.actor);
      const matches = (x: AuthzEvent) => {
        if (x.type !== e.type) return false;
        if (actor && (x.actor.type !== actor.type || x.actor.id !== actor.id)) return false;
        return Object.entries(e.data ?? {}).every(([k, v]) => {
          try {
            assert.deepEqual(x.data[k], v);
            return true;
          } catch {
            return false;
          }
        });
      };
      assert.ok(events.some(matches), `no AuthzEvent like ${JSON.stringify(e)} since ${name} in ${JSON.stringify(events)}`);
    },
  };
}

/**
 * The link token of result `index` saved as `name` appears in no audit entry, published change,
 * AuthzEvent (when the lane has adminEvents) or link listing (`AuthzAdmin.list` or GET /authz/links, as `lister`).
 */
export function tokenOnlyInResult(name: string, index = 0, via: Via = 'admin', lister: Who = SYSTEM): DoStep {
  return {
    note: 'the token appears only in the command result',
    do: async (ctx) => {
      const r = saved(ctx, name)[index];
      assert.ok(r?.ok && typeof r.token === 'string' && r.token.length > 0, `results "${name}"[${index}] carry no token: ${JSON.stringify(r)}`);
      const token = r.token;
      const absent = (where: string, value: unknown) => assert.ok(!JSON.stringify(value ?? null).includes(token), `the link token appears in ${where}`);
      absent('the audit entries', ctx.session.audit?.entries);
      absent('the published changes', ctx.session.bus?.published);
      absent('the AuthzEvents', ctx.session.lane?.adminEvents?.events);
      const actor = ctx.principal(lister);
      const items = via === 'http' ? (await laneHandle(ctx, 'adminHttp').list(actor, { kind: 'links' })).items : (await ctx.session.admin?.list(actor, { kind: 'links' }))?.items;
      assert.ok(items, 'no link listing');
      assert.ok(items.length > 0, 'the link listing is empty');
      absent('the link listing', items);
    },
  };
}

/** Writes a stored assignment row directly (lane handle rbacStore). */
export function storedAssignment(a: Assignment): DoStep {
  return { note: `stored row ${a.id} (${a.role})`, do: (ctx) => laneHandle(ctx, 'rbacStore').insertAssignment(a) };
}

/** No stored link row holds any of these tokens in clear text. */
export function linkRowsHide(tokens: readonly string[]): DoStep {
  return {
    note: 'link rows hold no clear token',
    do: async (ctx) => {
      const rows = await laneHandle(ctx, 'rbacStore').linkRows();
      assert.ok(rows.length > 0, 'no stored link rows');
      const text = JSON.stringify(rows);
      for (const t of tokens) assert.ok(!text.includes(t), `a stored link row holds the token ${t}`);
    },
  };
}

/** users' ImpersonationGuard: may `actor` impersonate `target`? */
export function impersonates(actor: Who, target: Who, e: { readonly ok: boolean; readonly code?: string }): DoStep {
  return {
    note: `impersonation of ${typeof target === 'string' ? target : target.id}`,
    do: async (ctx) => {
      const t = ctx.principal(target);
      const res = await laneHandle(ctx, 'impersonationGuard').allowed(ctx.principal(actor), { type: t.type, id: t.id });
      assert.equal(res.ok, e.ok, `impersonation answer ${JSON.stringify(res)}`);
      if (!res.ok && e.code !== undefined) assert.equal(res.code, e.code, 'impersonation refusal code');
    },
  };
}

/** Every page of `limit` is full but the last, and the pages together are the list (lane handle sqlPages). */
export function pagesAreFull(as: Who, permission: Permission, type: ResourceType, limit: number): DoStep {
  return {
    note: `pages of ${limit}`,
    do: async (ctx) => {
      const principal = ctx.principal(as);
      assert.ok(ctx.session.list, 'the session has no list handle');
      const all = await ctx.session.list(principal, permission, type);
      const pages = laneHandle(ctx, 'sqlPages');
      const seen: string[] = [];
      for (let offset = 0; offset <= all.length; offset += limit) {
        const page = await pages.page(principal, permission, type, { limit, offset });
        const expected = Math.min(limit, all.length - offset);
        assert.equal(page.length, expected, `page at offset ${offset} has ${page.length} rows, ${expected} expected`);
        seen.push(...page);
      }
      assert.deepEqual([...seen].sort(), [...all].sort(), 'the pages together are the list');
    },
  };
}

/**
 * Changes a scope node's attributes in the kit scope resolver that serves its type, as a change of the
 * attribute source would; a later `invalidate` step says which tags the change publishes.
 */
export function setResolverAttributes(ref: ResourceRef, attributes: Readonly<Record<string, unknown>>): DoStep {
  return {
    note: `attributes of ${ref.type}:${ref.id} change`,
    do: (ctx) => {
      const resolver = ctx.session.kit?.scopeResolvers.find((r) => r.types.includes(ref.type));
      assert.ok(resolver instanceof FakeScopeResolver, `no kit scope resolver serves ${ref.type}`);
      resolver.add(ref, undefined, attributes);
    },
  };
}
