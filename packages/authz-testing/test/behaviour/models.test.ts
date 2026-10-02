import assert from 'node:assert/strict';
import 'mocha';

import { FALSE, GLOBAL, SYSTEM, TRUE } from '@spinajs/authz';
import type { AuthzAdmin, AuthzCommand, AuthzCommandResult, Decision, Principal, ResourceRef } from '@spinajs/authz';

import { BEHAVIOUR_FIXTURES, FACETS, fixtureDsl, instantiateWorld, mergeFixtures, runBehaviour, userPrincipal, validateCase } from '../../src/index.js';
import type { BehaviourAuthz, BehaviourFixture, BehaviourHarness, BehaviourId, BehaviourSelector, Case, CoversStep, Facet, FixtureExtension, FixturePart, HarnessSession, LaneHandles, World } from '../../src/index.js';
import { MODEL_FIXTURES } from '../../src/behaviour/catalogue-models.js';
import { checks, exec, mark, since, tokenOnlyInResult, viaLink } from '../../src/behaviour/model-steps.js';
import { RULE_PERMISSIONS, RULE_PRINCIPALS, RULE_SETS } from '../../src/behaviour/rule-worlds.js';
import { ORACLE_FACETS, oracleHarness } from './oracle.js';
import { recorder } from './recorder.js';

const ALL: readonly (BehaviourFixture | FixtureExtension)[] = BEHAVIOUR_FIXTURES;
const merged = mergeFixtures(ALL);

const MINE: readonly BehaviourId[] = ['B11', 'B12', 'B13', 'B15', 'B16', 'B18', 'B19', 'B26', 'B31', 'B32', 'B33', 'B34', 'B35', 'B38', 'B40', 'B42', 'B43', 'B44', 'B45', 'B46'];
const FILLED: readonly string[] = ['B06.rules', 'B06.rulesSql', 'B27.events', 'B27.policyEvents', 'B36.rbac', 'B39.store'];

const part = (sel: string): FixturePart => {
  const [id, name] = sel.split('.') as [BehaviourId, string];
  const found = merged.get(id)?.parts.find((p) => p.name === name);
  assert.ok(found, sel);
  return found;
};

/** Every part of MODEL_FIXTURES as [id, part], after merging with the 4a catalogue. */
const myParts = (): [BehaviourId, FixturePart][] => {
  const out: [BehaviourId, FixturePart][] = [];
  for (const f of MODEL_FIXTURES) for (const p of f.parts) out.push([f.id, part(`${f.id}.${p.name}`)]);
  return out;
};

describe('model, store and admin fixtures', () => {
  it('merge with the catalogue: each model fixture has parts, and the empty parts 4a declared now hold cases', () => {
    for (const id of MINE) assert.ok((merged.get(id)?.parts.length ?? 0) > 0, `${id} has parts`);
    for (const sel of FILLED) assert.ok(part(sel).cases.length > 0, `${sel} has cases`);
    assert.equal(part('B40.memory').cases.length, 0, 'B40 is a stub that K1 fills');
  });

  it('every part has known facets, lanes or a note, unique names, and cases or a note saying who proposes them', () => {
    for (const [id, p] of myParts()) {
      assert.match(p.name, /^[A-Za-z][A-Za-z0-9-]*$/, `${id}.${p.name}`);
      assert.ok(p.facets.length > 0, `${id}.${p.name} needs facets`);
      for (const facet of p.facets) assert.ok(Object.hasOwn(FACETS, facet), `${id}.${p.name}: facet ${facet}`);
      assert.ok(p.lanes.length > 0 || p.note, `${id}.${p.name}: no lane names it, so its note must say why`);
      assert.ok(p.cases.length > 0 || p.note, `${id}.${p.name}: a part without cases says why`);
      const titles = p.cases.map((c) => c.name);
      assert.equal(new Set(titles).size, titles.length, `${id}.${p.name}: case names are unique`);
    }
    for (const f of merged.values()) assert.equal(new Set(f.parts.map((p) => p.name)).size, f.parts.length, `${f.id}: part names are unique`);
  });

  it('every world is well-formed and every step reference resolves', () => {
    const problems: string[] = [];
    for (const [id, p] of myParts()) for (const c of p.cases) problems.push(...validateCase(c, p.world).map((x) => `${id}.${p.name} ${x}`));
    assert.deepEqual(problems, []);
  });

  it('every world instantiates', () => {
    for (const [id, p] of myParts()) for (const c of p.cases) assert.doesNotThrow(() => instantiateWorld((c.world ?? p.world)!), `${id}.${p.name} ${c.name}`);
  });

  it('the runner registers each part with its facets and lanes, and each case under its part id', () => {
    const facets = Object.keys(FACETS) as Facet[];
    const rec = recorder();
    runBehaviour([...MINE, ...(FILLED as BehaviourSelector[])], () => ({ facets, setup: async () => assert.fail('not run') }), { mocha: rec.mocha, fixtures: ALL });
    const describes = new Set(rec.suites.map((s) => s[s.length - 1]));
    const tests = new Set(rec.tests.map((t) => t.title));
    for (const [id, p] of myParts()) {
      const title = `${id}.${p.name}`;
      assert.ok(describes.has(`${title} [${p.facets.join(', ')}]${p.lanes.length ? ` (${p.lanes.join(', ')})` : ''}`), `describe of ${title}`);
      if (p.cases.length === 0) assert.ok(tests.has(`${title} no cases yet: ${p.note}`), `pending test of ${title}`);
      for (const c of p.cases) assert.ok(tests.has(`${title} ${c.name}`), `${title} ${c.name}`);
    }
  });

  it('every rule set carries a denied and an allowed probe, and each rule part runs them after agree', () => {
    for (const s of RULE_SETS) {
      assert.ok(s.probes.some((p) => !p.allowed) && s.probes.some((p) => p.allowed), `${s.name}: probes`);
      assert.ok(
        s.probes.every((p) => RULE_PRINCIPALS.includes(p.as) && RULE_PERMISSIONS.includes(p.permission)),
        `${s.name}: probe names`,
      );
    }
    for (const sel of ['B06.rules', 'B06.rulesSql', 'B44.config', 'B44.db']) for (const c of part(sel).cases) assert.ok(c.steps.filter((x) => 'check' in x).length >= 2, `${sel} ${c.name}: probes`);
  });

  it('a harness without the facets of a part gets a pending test naming them', () => {
    const rec = recorder();
    runBehaviour(['B35'], () => ({ facets: ['engine', 'rbac'], setup: async () => assert.fail('not run') }), { mocha: rec.mocha, fixtures: ALL });
    assert.deepEqual(
      rec.tests.map((t) => [t.title, !!t.fn]),
      [
        ['B35.rules skipped: harness lacks facets ladders, rules', false],
        ['B35.conditions skipped: harness lacks facets ladders, rules, conditions', false],
      ],
    );
  });
});

// ---------------------------------------------------------------------------------------------
// B26.core under the reference engine, with covers added here (oracle.ts has none): the combined
// GLOBAL set is the union of the kit models' summaries; an entry is unconditional when any model gives
// it unconditionally; a target entry is covered by an unconditional holder entry, or by a conditional
// one when it is conditional itself (a case the fixtures leave out).

type Entries = Map<string, boolean>;

async function summaryOf(session: HarnessSession, p: Principal, at: ResourceRef): Promise<Entries> {
  const out: Entries = new Map();
  const ctx = session.kit!.context();
  for (const m of session.kit!.models) {
    const s = await m.summarize?.(p, at, ctx);
    for (const e of s?.permissions ?? []) out.set(e.name, out.has(e.name) ? out.get(e.name)! && e.conditional : e.conditional);
  }
  return out;
}

const within = (a: Entries, b: Entries): boolean => [...a].every(([name, conditional]) => b.has(name) && (!b.get(name) || conditional));

function coversHarness(): BehaviourHarness {
  const base = oracleHarness();
  return {
    facets: ORACLE_FACETS,
    async setup(world, ctx) {
      const session = await base.setup(world, ctx);
      const authz = session.authz!;
      const covers = async (holder: Principal, target: Principal, at: ResourceRef = GLOBAL) => {
        const [h, t] = [await summaryOf(session, holder, at), await summaryOf(session, target, at)];
        return within(t, h) && !within(h, t);
      };
      return { ...session, authz: Object.assign(Object.create(authz) as BehaviourAuthz, { covers }) };
    },
  };
}

runBehaviour(['B26.core'], coversHarness, { fixtures: ALL });

describe('B26.core under the reference engine with covers', () => {
  it('a flipped covers expectation fails', async () => {
    const p = part('B26.core');
    const original = p.cases[0];
    const flip = (c: Case): Case => ({ ...c, steps: c.steps.map((s, i) => (i === 0 ? { ...(s as CoversStep), expect: !(s as CoversStep).expect } : s)) });
    const run = async (c: Case) => {
      const rec = recorder();
      runBehaviour(['B26.core'], coversHarness, { mocha: rec.mocha, fixtures: [fixtureDsl.fixture('B26', [{ ...p, cases: [c] }])] });
      return (await rec.run())[0].state;
    };
    assert.equal(await run(original), 'passed');
    assert.equal(await run(flip(original)), 'failed');
  });
});

// ---------------------------------------------------------------------------------------------
// The `do` steps of model-steps.ts against stub handles.

const alice = userPrincipal('alice');
const stubWorld: World = { permissions: ['file:read'], principals: { alice }, combine: fixtureDsl.combine('deny-overrides') };
const decision = (allowed: boolean): Decision => ({ allowed, permission: 'file:read', resource: { type: 'file' }, principal: { type: 'user', id: 'alice' }, residual: allowed ? TRUE : FALSE, fields: { read: [], write: [] }, roles: {}, domain: 'root' });

interface StubAdmin {
  readonly calls: { actor: Principal; commands: readonly AuthzCommand[]; opts: unknown }[];
  readonly admin: AuthzAdmin;
}

function stubAdmin(answer: (commands: readonly AuthzCommand[]) => readonly AuthzCommandResult[]): StubAdmin {
  const calls: StubAdmin['calls'] = [];
  const admin = {
    execute: async (actor: Principal, commands: readonly AuthzCommand[], opts?: unknown) => {
      calls.push({ actor, commands, opts });
      return answer(commands);
    },
    list: async () => ({ items: [{ id: 'l1' }], total: 1 }),
  } as unknown as AuthzAdmin;
  return { calls, admin };
}

async function runSteps(steps: Case['steps'], session: Partial<HarnessSession>): Promise<string> {
  const rec = recorder();
  const harness: BehaviourHarness = {
    facets: ['engine'],
    setup: async (w) => ({ authz: { check: async () => decision(true), checkMany: async () => new Map(), explain: async () => decision(true) }, kit: instantiateWorld(w), ...session, dispose: async () => undefined }),
  };
  runBehaviour(['B43.admin'], () => harness, { mocha: rec.mocha, fixtures: [fixtureDsl.fixture('B43', [{ name: 'admin', facets: ['engine'], lanes: [], cases: [{ name: 'stub', world: stubWorld, steps }] }])] });
  return (await rec.run())[0].state;
}

const GRANT: AuthzCommand = { kind: 'assignment.grant', subject: { type: 'user', id: 'alice' }, role: 'viewer', scope: GLOBAL };
const okResult = (r: Partial<AuthzCommandResult> = {}): AuthzCommandResult => ({ ok: true, kind: 'assignment.grant', affected: 1, ...r } as AuthzCommandResult);

describe('model-steps do steps', () => {
  it('exec hands actor, commands and options to AuthzAdmin.execute and checks every result', async () => {
    const s = stubAdmin((c) => c.map(() => okResult()));
    assert.equal(await runSteps([exec(SYSTEM, [GRANT, GRANT], 'ok', { idempotencyKey: 'k' })], { admin: s.admin }), 'passed');
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].actor, SYSTEM);
    assert.deepEqual(s.calls[0].commands, [GRANT, GRANT]);
    assert.deepEqual(s.calls[0].opts, { idempotencyKey: 'k' });
  });

  it('exec fails on a missing result, a failure where none is expected, or a wrong code', async () => {
    const short = stubAdmin(() => [okResult()]);
    assert.equal(await runSteps([exec(SYSTEM, [GRANT, GRANT], 'ok')], { admin: short.admin }), 'failed');
    const failing = stubAdmin(() => [okResult(), { ok: false, kind: 'assignment.grant', error: { code: 'unknown_role', message: 'x' } }]);
    assert.equal(await runSteps([exec(SYSTEM, [GRANT, GRANT], 'ok')], { admin: failing.admin }), 'failed');
    assert.equal(await runSteps([exec(SYSTEM, [GRANT, GRANT], { failsAt: 1, code: 'unknown_role' })], { admin: failing.admin }), 'passed');
    assert.equal(await runSteps([exec(SYSTEM, [GRANT, GRANT], { failsAt: 1, code: 'escalation' })], { admin: failing.admin }), 'failed');
    assert.equal(await runSteps([exec(SYSTEM, [GRANT, GRANT], { failsAt: 0 })], { admin: failing.admin }), 'failed');
  });

  it('exec fails when a command before failsAt failed, or a result answers another command kind', async () => {
    const fail = (code: string): AuthzCommandResult => ({ ok: false, kind: 'assignment.grant', error: { code, message: 'x' } });
    const twoFailures = stubAdmin(() => [fail('escalation'), fail('unknown_role')]);
    assert.equal(await runSteps([exec(SYSTEM, [GRANT, GRANT], { failsAt: 1, code: 'unknown_role' })], { admin: twoFailures.admin }), 'failed');
    const LINK: AuthzCommand = { kind: 'link.create', scope: GLOBAL, role: 'viewer' };
    const swapped = stubAdmin(() => [okResult({ kind: 'link.create' }), okResult()]);
    assert.equal(await runSteps([exec(SYSTEM, [GRANT, LINK], 'ok')], { admin: swapped.admin }), 'failed');
    assert.equal(await runSteps([exec(SYSTEM, [LINK, GRANT], 'ok')], { admin: swapped.admin }), 'passed');
  });

  it('exec over HTTP goes through the adminHttp handle', async () => {
    const seen: unknown[] = [];
    const adminHttp: LaneHandles['adminHttp'] = {
      execute: async (actor, body) => {
        seen.push([actor, body]);
        return { status: 200, results: body.commands.map(() => okResult()) };
      },
      list: async () => ({ status: 200, items: [] }),
    };
    assert.equal(await runSteps([exec('alice', [GRANT], 'ok', { via: 'http', dryRun: true })], { lane: { adminHttp } }), 'passed');
    assert.deepEqual(seen, [[alice, { commands: [GRANT], dryRun: true }]]);
    assert.equal(await runSteps([exec('alice', [GRANT], 'ok', { via: 'http' })], {}), 'failed');
  });

  it('a retried batch must answer as the first', async () => {
    let n = 0;
    const s = stubAdmin(() => [okResult({ id: `a${n++}` })]);
    assert.equal(await runSteps([exec(SYSTEM, [GRANT], 'ok', { save: 'first' }), exec(SYSTEM, [GRANT], 'ok', { sameAs: 'first' })], { admin: s.admin }), 'failed');
    const same = stubAdmin(() => [okResult({ id: 'a1' })]);
    assert.equal(await runSteps([exec(SYSTEM, [GRANT], 'ok', { save: 'first' }), exec(SYSTEM, [GRANT], 'ok', { sameAs: 'first' })], { admin: same.admin }), 'passed');
  });

  it('tokenOnlyInResult fails when the token shows up in the audit entries', async () => {
    const s = stubAdmin(() => [okResult({ kind: 'link.create', id: 'l1', token: 'secret-token' })]);
    const LINK: AuthzCommand = { kind: 'link.create', scope: GLOBAL, role: 'viewer' };
    const clean = { admin: s.admin, audit: { entries: [{ kind: 'admin' as const, principal: { type: 'system', id: 'system' } }] } };
    assert.equal(await runSteps([exec(SYSTEM, [LINK], 'ok', { save: 'link' }), tokenOnlyInResult('link')], clean), 'passed');
    const leaky = { admin: s.admin, audit: { entries: [{ kind: 'admin' as const, principal: { type: 'system', id: 'system' }, command: { token: 'secret-token' } }] } };
    assert.equal(await runSteps([exec(SYSTEM, [LINK], 'ok', { save: 'link' }), tokenOnlyInResult('link')], leaky), 'failed');
  });

  it('mark and since count the changes and admin audit entries in between', async () => {
    const published: unknown[] = [];
    const entries: { kind: 'admin'; principal: { type: string; id: string } }[] = [];
    const s = stubAdmin((c) => {
      published.push({ tags: [], at: new Date(0) });
      for (const _ of c) entries.push({ kind: 'admin', principal: { type: 'system', id: 'system' } });
      return c.map(() => okResult());
    });
    const session = { admin: s.admin, audit: { entries }, bus: { publish: async () => undefined, published: published as never } };
    assert.equal(await runSteps([mark('m'), exec(SYSTEM, [GRANT, GRANT], 'ok'), since('m', { published: 1, adminAudit: 2 })], session), 'passed');
    assert.equal(await runSteps([mark('m'), exec(SYSTEM, [GRANT], 'ok'), since('m', { published: 0 })], session), 'failed');
  });

  it('viaLink resolves a token through the rbacLinks handle, with the companion', async () => {
    const asked: unknown[] = [];
    const rbacLinks: LaneHandles['rbacLinks'] = {
      principal: async (token, companion) => {
        asked.push([token, companion?.id]);
        return userPrincipal('link-holder');
      },
    };
    assert.equal(await runSteps([checks(viaLink('tok', 'alice'), [{ permission: 'file:read', expect: { allowed: true } }])], { lane: { rbacLinks } }), 'passed');
    assert.deepEqual(asked, [['tok', 'alice']]);
    assert.equal(await runSteps([checks(viaLink('tok'), [{ permission: 'file:read', expect: { allowed: true } }])], {}), 'failed');
  });
});
