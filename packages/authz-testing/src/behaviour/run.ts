import assert from 'node:assert/strict';

import { SYSTEM, UNATTENDED, principalKey, resourceKey } from '@spinajs/authz';
import type { CheckInput, Decision, Principal, ResourceFilter, ResourceRef, ResourceType } from '@spinajs/authz';

import { BEHAVIOUR_FIXTURES } from './catalogue.js';
import { assertDecision, assertResidualShape, assertThrows, isThrows, outcome } from './expect.js';
import type { BehaviourAuthz, BehaviourHarness, HarnessSession, SetupContext, StepContext } from './harness.js';
import { BEHAVIOUR_RULES } from './rules.js';
import type { BehaviourFixture, BehaviourId, BehaviourSelector, Case, CheckRequest, DecisionExpectation, Facet, FixtureExtension, FixturePart, ResidualExpectation, Step, Who, World } from './types.js';
import { instantiateWorld, resolvePrincipal, selectRows } from './world.js';
import type { KitWorld } from './world.js';

/** The mocha calls the runner makes; mocha's globals by default. */
export interface MochaLike {
  describe(title: string, fn: () => void): void;
  /** Without `fn` the test is pending. */
  it(title: string, fn?: (this: unknown) => Promise<void>): void;
  before(fn: () => Promise<void>): void;
  after(fn: () => Promise<void>): void;
}

export interface RunBehaviourOptions {
  /** Parts the harness cannot run, and parts without cases, fail instead of pending. */
  readonly strict?: boolean;
  /** Per case. */
  readonly timeoutMs?: number;
  /** Default: the kit's catalogue (`BEHAVIOUR_FIXTURES`). */
  readonly fixtures?: readonly (BehaviourFixture | FixtureExtension)[];
  readonly mocha?: MochaLike;
}

const SELECTOR = /^(B\d\d)(?:\.([A-Za-z][A-Za-z0-9-]*))?$/;

const isRuleId = (id: string): id is BehaviourId => Object.hasOwn(BEHAVIOUR_RULES, id);

/**
 * Merges fixtures and extensions by id, in any order: of two parts with one name, the one with cases
 * stands in for a declared one without cases; two with cases (or two without) are an error.
 */
export function mergeFixtures(list: readonly (BehaviourFixture | FixtureExtension)[]): ReadonlyMap<BehaviourId, BehaviourFixture> {
  const out = new Map<BehaviourId, { rule?: string; parts: FixturePart[] }>();
  for (const f of list) {
    if (!isRuleId(f.id)) throw new Error(`behaviour fixtures: unknown id ${f.id}`);
    const entry = out.get(f.id) ?? { parts: [] };
    out.set(f.id, entry);
    if ('rule' in f) {
      if (entry.rule !== undefined) throw new Error(`behaviour fixtures: ${f.id} is defined twice`);
      entry.rule = f.rule;
    }
    for (const p of f.parts) {
      const at = entry.parts.findIndex((x) => x.name === p.name);
      if (at < 0) {
        entry.parts.push(p);
        continue;
      }
      const filled = [entry.parts[at], p].filter((x) => x.cases.length > 0);
      if (filled.length !== 1) throw new Error(`behaviour fixtures: part ${f.id}.${p.name} is defined twice`);
      entry.parts[at] = filled[0];
    }
  }
  return new Map([...out].map(([id, e]) => [id, { id, rule: e.rule ?? BEHAVIOUR_RULES[id], parts: e.parts }]));
}

function globalMocha(): MochaLike {
  const g = globalThis as unknown as Partial<MochaLike>;
  if (typeof g.describe !== 'function' || typeof g.it !== 'function' || typeof g.before !== 'function' || typeof g.after !== 'function') {
    throw new Error('runBehaviour: mocha globals (describe, it, before, after) not found; run it from a mocha test file or pass opts.mocha');
  }
  return { describe: g.describe, it: g.it, before: g.before, after: g.after };
}

const short = (text: string, max = 110): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/**
 * Registers the behaviour fixtures `ids` as mocha suites against the harness `harnessFactory` builds
 * (called once): one describe per fixture and per part, one test per case, titled `B03.core <case>`.
 * 'B09' runs every part, 'B09.core' one part. A part needing facets the harness lacks is a pending
 * test naming them when reached through the bare id, and a failing one when named explicitly or with
 * `strict`. Unknown ids and an empty list throw here, at registration.
 */
export function runBehaviour(ids: BehaviourSelector | readonly BehaviourSelector[], harnessFactory: () => BehaviourHarness, opts: RunBehaviourOptions = {}): void {
  const selectors = typeof ids === 'string' ? [ids] : ids;
  if (selectors.length === 0) throw new Error('runBehaviour: no behaviour ids given');
  const fixtures = mergeFixtures(opts.fixtures ?? BEHAVIOUR_FIXTURES);
  const selection = new Map<BehaviourId, { whole: boolean; parts: Set<string> }>();
  for (const sel of selectors) {
    const m = SELECTOR.exec(sel);
    if (!m || !isRuleId(m[1])) throw new Error(`runBehaviour: unknown behaviour id ${JSON.stringify(sel)}`);
    const id = m[1];
    const fixture = fixtures.get(id);
    if (m[2] !== undefined && !fixture?.parts.some((p) => p.name === m[2])) throw new Error(`runBehaviour: ${id} has no part ${JSON.stringify(m[2])}${fixture ? ` (parts: ${fixture.parts.map((p) => p.name).join(', ')})` : ''}`);
    const entry = selection.get(id) ?? { whole: false, parts: new Set<string>() };
    if (m[2] === undefined) entry.whole = true;
    else entry.parts.add(m[2]);
    selection.set(id, entry);
  }

  const mocha = opts.mocha ?? globalMocha();
  const harness = harnessFactory();
  const facets = new Set(harness.facets);

  mocha.describe(`behaviour fixtures [${[...facets].join(', ')}]`, () => {
    if (harness.beforeAll) mocha.before(() => harness.beforeAll!());
    if (harness.afterAll) mocha.after(() => harness.afterAll!());

    for (const [id, sel] of selection) {
      const fixture = fixtures.get(id);
      mocha.describe(`${id} ${short(BEHAVIOUR_RULES[id])}`, () => {
        if (!fixture || fixture.parts.length === 0) {
          mocha.it(`${id} has no fixture parts yet`, async () => {
            throw new Error(`${id}: the kit has no fixture parts for this rule yet`);
          });
          return;
        }
        for (const part of fixture.parts) {
          const explicit = sel.parts.has(part.name);
          if (!sel.whole && !explicit) continue;
          registerPart(mocha, harness, facets, id, part, explicit || !!opts.strict, opts.timeoutMs);
        }
      });
    }
  });
}

function registerPart(mocha: MochaLike, harness: BehaviourHarness, facets: ReadonlySet<Facet>, id: BehaviourId, part: FixturePart, mustRun: boolean, timeoutMs: number | undefined): void {
  const title = `${id}.${part.name}`;
  mocha.describe(`${title} [${part.facets.join(', ')}]${part.lanes.length ? ` (${part.lanes.join(', ')})` : ''}`, () => {
    const missing = part.facets.filter((f) => !facets.has(f));
    if (missing.length > 0) {
      const why = `harness lacks facets ${missing.join(', ')}`;
      if (mustRun)
        mocha.it(`${title} cannot run: ${why}`, async () => {
          throw new Error(`${title} needs facets ${part.facets.join(', ')}; the ${why}`);
        });
      else mocha.it(`${title} skipped: ${why}`);
      return;
    }
    if (part.cases.length === 0) {
      const why = `no cases yet${part.note ? `: ${part.note}` : ''}`;
      if (mustRun)
        mocha.it(`${title} has ${why}`, async () => {
          throw new Error(`${title} has ${why}`);
        });
      else mocha.it(`${title} ${why}`);
      return;
    }
    for (const c of part.cases) {
      const caseTitle = `${title} ${c.name}`;
      mocha.it(caseTitle, async function (this: unknown) {
        const ctx = this as { timeout?: (ms: number) => void } | undefined;
        if (timeoutMs !== undefined && typeof ctx?.timeout === 'function') ctx.timeout(timeoutMs);
        await runCase(harness, { id, part: part.name, case: c.name, title: caseTitle, facets: part.facets }, c, c.world ?? part.world);
      });
    }
  });
}

const DOMAIN_TOKEN = '$domain';

/** The expectation with `$domain` replaced by the harness's root domain name. */
function inDomain<T>(e: T, domain: string): T {
  const put = (s: string) => s.split(DOMAIN_TOKEN).join(domain);
  if (isThrows(e)) return e.message ? { ...e, message: e.message.map(put) } : e;
  const d = (e as DecisionExpectation | null)?.domain;
  return typeof d === 'string' ? { ...e, domain: put(d) } : e;
}

/** Runs one case: setup, the steps, and dispose (also when a step fails). */
export async function runCase(harness: BehaviourHarness, ctx: SetupContext, c: Case, world: World | undefined): Promise<void> {
  if (!world) throw new Error(`${ctx.title}: the case has no world`);
  const rootDomain = harness.domain ?? 'root';
  let session: HarnessSession;
  try {
    session = await harness.setup(world, ctx);
  } catch (e) {
    if (!c.boot) throw e;
    assertThrows(e, inDomain(c.boot, rootDomain), `${ctx.title}: setup`);
    return;
  }

  let failure: unknown;
  try {
    if (c.boot && !c.boot.orAtCall) assert.fail(`${ctx.title}: setup was expected to reject with ${c.boot.throws}`);
    assertHandles(session, ctx.facets, ctx.title);
    await runSteps(new Runner(session, world, session.domain ?? rootDomain), c.steps, '');
  } catch (e) {
    failure = e;
  }
  try {
    await session.dispose();
  } catch (e) {
    failure ??= e;
  }
  if (failure !== undefined) throw failure;
}

const HANDLES: Partial<Record<Facet, (s: HarnessSession) => boolean>> = {
  engine: (s) => !!s.authz && !!s.kit,
  audit: (s) => !!s.audit,
  clock: (s) => !!s.clock,
  bus: (s) => !!s.bus,
  host: (s) => !!s.domains && typeof s.authz?.runAs === 'function' && typeof s.authz.current === 'function',
  admin: (s) => !!s.admin,
  list: (s) => typeof s.list === 'function',
};

function assertHandles(session: HarnessSession, facets: readonly Facet[], title: string): void {
  for (const f of facets) {
    const has = HANDLES[f];
    if (has && !has(session)) assert.fail(`${title}: the session misses the handle of facet ${f}`);
  }
}

class Runner implements StepContext {
  private localKit?: KitWorld;

  constructor(readonly session: HarnessSession, readonly world: World, readonly domain: string) {}

  expected<T>(e: T): T {
    return inDomain(e, this.domain);
  }

  authz(domain?: string): BehaviourAuthz {
    if (domain !== undefined && domain !== 'root') {
      assert.ok(this.session.domains, `domain ${domain}: the session has no domains handle`);
      return this.session.domains.service(domain);
    }
    assert.ok(this.session.authz, 'the session has no authz handle');
    return this.session.authz;
  }

  principal(who: Who): Principal {
    if (who === '$current') {
      const current = this.authz().current;
      assert.ok(current, "'$current' needs authz.current()");
      return current.call(this.session.authz);
    }
    return resolvePrincipal(this.world, who);
  }

  rows(type: ResourceType) {
    return this.kit().rows(type);
  }

  async subject(ref: ResourceRef): Promise<unknown> {
    if (this.session.load) return this.session.load(ref);
    const row = this.kit().row(ref);
    assert.ok(row, `no world row ${resourceKey(ref)}`);
    return row;
  }

  select(residual: ResourceFilter, type: ResourceType, principal: Principal, actor?: Principal): Promise<readonly string[]> {
    // Under 'inherit' the models speak for the delegate, so its residual reads principal.* from the delegate.
    if (principal.onBehalfOf && principal.delegation === 'inherit') return selectRows(this.kit(), residual, type, principal.onBehalfOf, actor ?? principal);
    return selectRows(this.kit(), residual, type, principal, actor);
  }

  staticModel(name: string, domain?: string) {
    assert.ok(this.session.kit, 'the session has no kit (engine facet)');
    return this.session.kit.staticModel(name, domain);
  }

  // The runner's own kit: world rows and kit native filters for `selects`, untouched by the harness.
  private kit(): KitWorld {
    return (this.localKit ??= instantiateWorld(this.world));
  }

  async input(req: CheckRequest): Promise<CheckInput> {
    const subject = req.subject === 'row' ? await this.subject(req.resource ?? { type: '' }) : req.subject;
    return {
      principal: this.principal(req.as),
      permission: req.permission,
      ...(req.resource ? { resource: req.resource } : {}),
      ...(subject !== undefined ? { subject } : {}),
      ...(req.actor !== undefined ? { actor: this.principal(req.actor) } : {}),
      ...(req.env ? { env: req.env } : {}),
    };
  }

  async decision(d: Decision, e: DecisionExpectation, principal: Principal, actor: Principal | undefined, what: string): Promise<void> {
    const selects = assertDecision(d, this.expected(e), what);
    if (selects) await this.selects(d.residual, d.resource.type, principal, actor, selects, what);
  }

  async residual(actual: ResourceFilter | undefined, e: ResidualExpectation, type: ResourceType, principal: Principal, what: string): Promise<void> {
    const selects = assertResidualShape(actual, e, what);
    if (selects) await this.selects(actual!, type, principal, undefined, selects, what);
  }

  private async selects(residual: ResourceFilter, type: ResourceType, principal: Principal, actor: Principal | undefined, expected: readonly string[], what: string): Promise<void> {
    const got = await this.select(residual, type, principal, actor);
    assert.deepEqual([...got].sort(), [...expected].sort(), `${what}: rows selected by ${JSON.stringify(residual)}`);
  }
}

const KINDS = ['check', 'explain', 'can', 'assert', 'checkMany', 'filter', 'filterNow', 'agree', 'summary', 'covers', 'preload', 'invalidate', 'advance', 'publish', 'runAs', 'current', 'models', 'disposeDomain', 'calls', 'audit', 'published', 'do'] as const;

const kindOf = (step: Step): string => KINDS.find((k) => k in step) ?? 'unknown';

async function runSteps(r: Runner, steps: readonly Step[], path: string): Promise<void> {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const where = `step ${path}${i} (${kindOf(step)}${'note' in step && step.note ? `: ${step.note}` : ''})`;
    try {
      await runStep(r, step, `${path}${i}.`);
    } catch (e) {
      if (e instanceof Error && !e.message.startsWith('step ')) e.message = `${where}: ${e.message}`;
      throw e;
    }
  }
}

function method<K extends keyof BehaviourAuthz>(authz: BehaviourAuthz, name: K): NonNullable<BehaviourAuthz[K]> {
  const fn = authz[name];
  assert.ok(typeof fn === 'function', `the harness's authz has no ${String(name)}()`);
  return (fn as (...args: unknown[]) => unknown).bind(authz) as NonNullable<BehaviourAuthz[K]>;
}

async function runStep(r: Runner, step: Step, path: string): Promise<void> {
  if ('check' in step || 'explain' in step || 'assert' in step) {
    const [req, call] = 'check' in step ? [step.check, 'check' as const] : 'explain' in step ? [step.explain, 'explain' as const] : [step.assert, 'assert' as const];
    const authz = r.authz(req.domain);
    const input = await r.input(req);
    const run = (): Promise<Decision> => (call === 'assert' ? method(authz, 'assert')(input.principal, input.permission, input.resource, input.subject) : method(authz, call)(input));
    const res = await outcome(run, r.expected(step.expect), call);
    if (!res.threw) await r.decision(res.value, step.expect as DecisionExpectation, input.principal, input.actor, call);
    return;
  }
  if ('can' in step) {
    const input = await r.input(step.can);
    const res = await outcome(() => method(r.authz(step.can.domain), 'can')(input.principal, input.permission, input.resource, input.subject), r.expected(step.expect), 'can');
    if (!res.threw) assert.equal(res.value, step.expect, 'can');
    return;
  }
  if ('checkMany' in step) {
    const req = step.checkMany;
    const principal = r.principal(req.as);
    const res = await outcome(() => method(r.authz(req.domain), 'checkMany')(principal, req.permissions, req.resource), r.expected(step.expect), 'checkMany');
    if (res.threw) return;
    const expect = step.expect as Readonly<Record<string, DecisionExpectation>>;
    for (const p of req.permissions) assert.ok(res.value.has(p), `checkMany: no decision for ${p}`);
    for (const [p, e] of Object.entries(expect)) await r.decision(res.value.get(p)!, e, principal, undefined, `checkMany ${p}`);
    return;
  }
  if ('filter' in step || 'filterNow' in step) {
    const [req, call] = 'filter' in step ? [step.filter, 'filter' as const] : [step.filterNow, 'filterNow' as const];
    const principal = r.principal(req.as);
    const authz = r.authz(req.domain);
    const res = await outcome(async () => method(authz, call)(principal, req.permission, req.type), r.expected(step.expect), call);
    if (res.threw) return;
    if (step.expect === 'undefined') assert.equal(res.value, undefined, `${call}: expected undefined, got ${JSON.stringify(res.value)}`);
    else {
      assert.ok(res.value !== undefined, `${call}: returned undefined`);
      await r.residual(res.value, step.expect as ResidualExpectation, req.type, principal, call);
    }
    return;
  }
  if ('agree' in step) return agree(r, step.agree);
  if ('summary' in step) {
    const s = await method(r.authz(step.summary.domain), 'summary')(r.principal(step.summary.as), step.summary.at);
    for (const p of step.expect.permissions ?? []) {
      const found = s.permissions.find((x) => x.name === p.name);
      assert.ok(found, `summary: no ${p.name} in ${JSON.stringify(s.permissions)}`);
      if (p.conditional !== undefined) assert.equal(found.conditional, p.conditional, `summary: ${p.name}.conditional`);
    }
    for (const p of step.expect.absent ?? []) assert.ok(!s.permissions.some((x) => x.name === p), `summary: ${p} is present`);
    return;
  }
  if ('covers' in step) {
    const c = step.covers;
    assert.equal(await method(r.authz(c.domain), 'covers')(r.principal(c.holder), r.principal(c.target), c.at), step.expect, 'covers');
    return;
  }
  if ('preload' in step) return method(r.authz(step.domain), 'preload')(r.principal(step.preload));
  if ('invalidate' in step) return void method(r.authz(step.domain), 'invalidate')(step.invalidate);
  if ('advance' in step) {
    assert.ok(r.session.clock, 'advance: the session has no clock');
    r.session.clock.advance(step.advance);
    return;
  }
  if ('publish' in step) {
    assert.ok(r.session.bus, 'publish: the session has no bus');
    return r.session.bus.publish({ ...step.publish, at: r.session.clock?.now() ?? r.world.now ?? new Date() });
  }
  if ('runAs' in step) {
    const runAs = method(r.authz(), 'runAs');
    await runAs(r.principal(step.runAs.as), step.runAs.reason, () => runSteps(r, step.steps, path));
    return;
  }
  if ('current' in step) {
    const want = r.principal(step.current);
    const got = method(r.authz(), 'current')();
    if (want === SYSTEM || want === UNATTENDED) assert.equal(got, want, `current is ${principalKey(got)}`);
    else assert.equal(principalKey(got), principalKey(want), 'current');
    return;
  }
  if ('models' in step) {
    const names = method(r.authz(step.domain), 'models')().map((m) => m.name);
    assert.deepEqual([...names].sort(), [...step.models].sort(), 'models()');
    return;
  }
  if ('disposeDomain' in step) {
    assert.ok(r.session.domains, 'disposeDomain: the session has no domains handle');
    return r.session.domains.dispose(step.disposeDomain);
  }
  if ('calls' in step) {
    const c = step.calls;
    const calls = r.staticModel(c.model, c.domain).calls.filter((x) => x.method === (c.method ?? 'evaluate'));
    const label = `${c.model}${c.domain ? `@${c.domain}` : ''}.${c.method ?? 'evaluate'}`;
    if (c.count !== undefined) assert.equal(calls.length, c.count, `calls of ${label}`);
    if (c.atLeast !== undefined) assert.ok(calls.length >= c.atLeast, `calls of ${label}: ${calls.length} < ${c.atLeast}`);
    if (c.lastArgs !== undefined) {
      assert.ok(calls.length > 0, `calls of ${label}: none`);
      assert.deepEqual(calls[calls.length - 1].args, c.lastArgs, `last args of ${label}`);
    }
    return;
  }
  if ('audit' in step) {
    assert.ok(r.session.audit, 'audit: the session has no audit handle');
    const a = step.audit;
    const who = a.principal === undefined ? undefined : principalKey(r.principal(a.principal));
    const hits = r.session.audit.entries.filter((e) => e.kind === a.kind && (a.reason === undefined || e.reason === a.reason) && (a.permission === undefined || e.permission === a.permission) && (who === undefined || principalKey(e.principal) === who));
    if (a.count !== undefined) assert.equal(hits.length, a.count, `audit entries ${JSON.stringify(a)} in ${JSON.stringify(r.session.audit.entries)}`);
    else assert.ok(hits.length > 0, `no audit entry ${JSON.stringify(a)} in ${JSON.stringify(r.session.audit.entries)}`);
    return;
  }
  if ('published' in step) {
    const published = r.session.bus?.published;
    assert.ok(published, 'published: the session bus does not record published changes');
    const hits = published.filter((c) => step.published.tags.every((t) => c.tags.includes(t)));
    if (step.published.count !== undefined) assert.equal(hits.length, step.published.count, 'published changes');
    else assert.ok(hits.length > 0, `no published change with tags ${step.published.tags.join(', ')}`);
    return;
  }
  if ('do' in step) return step.do(r);
  assert.fail(`unknown step ${JSON.stringify(Object.keys(step))}`);
}

async function agree(r: Runner, req: { readonly as: readonly Who[]; readonly permissions: readonly string[]; readonly type: ResourceType; readonly domain?: string }): Promise<void> {
  const authz = r.authz(req.domain);
  for (const who of req.as) {
    const principal = r.principal(who);
    for (const permission of req.permissions) {
      const label = `${principalKey(principal)} ${permission}`;
      const residual = await method(authz, 'filter')(principal, permission, req.type);
      const listed = new Set(r.session.list ? await r.session.list(principal, permission, req.type) : await r.select(residual, req.type, principal));
      for (const row of r.rows(req.type)) {
        const ref = { type: req.type, id: row.id };
        const d = await authz.check({ principal, permission, resource: ref, subject: await r.subject(ref) });
        assert.equal(d.allowed, listed.has(row.id), `agree ${label} ${resourceKey(ref)}: check says ${d.allowed}, the filter ${listed.has(row.id) ? 'lists' : 'leaves out'} the row (residual ${JSON.stringify(residual)})`);
        assert.ok(['true', 'false'].includes(d.residual.op), `agree ${label} ${resourceKey(ref)}: a check with a subject left the residual ${JSON.stringify(d.residual)}`);
      }
    }
  }
}
