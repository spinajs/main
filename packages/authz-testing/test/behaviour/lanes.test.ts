import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import 'mocha';
import ts from 'typescript';

import { AccessDenied, FALSE, SYSTEM, TRUE, UNATTENDED, principalKey } from '@spinajs/authz';
import type { Decision, Principal } from '@spinajs/authz';

import { BEHAVIOUR_FIXTURES, BEHAVIOUR_RULES, FACETS, fixtureDsl, instantiateWorld, laneSteps, mergeFixtures, modelSteps, resolvePrincipal, runBehaviour, userPrincipal, validateCase } from '../../src/index.js';
import type { BehaviourAuthz, BehaviourHarness, DoStep, Facet, HarnessSession, HttpHandle, LaneHandles, LaneWorld, StepContext, Step, TokenPrincipalExpectation, World } from '../../src/index.js';
import { LANE_FIXTURES } from '../../src/behaviour/catalogue-lanes.js';
import { accessOfFlow, actorIsKept, as, checkKept, emitted, flow, fsCall, fsRaw, handled, http, matches, orm, ormRows, token, tracesOnlyAtDebug, versionAs, versionChanged } from '../../src/behaviour/lane.js';
import type { FsArg, HttpRequest, HttpResponse, OrmQuery, QueueMessage } from '../../src/behaviour/lane.js';
import { recorder } from './recorder.js';

const { combine } = fixtureDsl;

const merged = mergeFixtures(BEHAVIOUR_FIXTURES);
const OWN_RULES = ['B10', 'B20', 'B21', 'B23', 'B24', 'B25', 'B28', 'B30', 'B41'] as const;
const FILLED = ['B02.http', 'B07.token', 'B09.orm', 'B09.http', 'B09.queue', 'B09.configuration', 'B09.socket', 'B09.email', 'B17.http', 'B17.users', 'B27.store', 'B27.queue', 'B29.fs', 'B37.token'];
const lanePart = (selector: string) => {
  const [id, name] = selector.split('.');
  return merged.get(id as never)?.parts.find((p) => p.name === name);
};
const laneParts = () => LANE_FIXTURES.flatMap((f) => f.parts.map((p) => ({ id: f.id, part: p })));

describe('lane fixtures', () => {
  describe('catalogue', () => {
    it('merges with the kit catalogue: every lane part fills an empty one or is new', () => {
      assert.doesNotThrow(() => mergeFixtures(BEHAVIOUR_FIXTURES));
      for (const id of OWN_RULES) {
        const f = merged.get(id);
        assert.ok(f && f.parts.length > 0, id);
        assert.equal(f.rule, BEHAVIOUR_RULES[id], id);
      }
      for (const sel of FILLED) assert.ok((lanePart(sel)?.cases.length ?? 0) > 0, `${sel} has cases`);
    });

    it('defines the rules it owns once and extends the others', () => {
      const defined = LANE_FIXTURES.filter((f) => 'rule' in f).map((f) => f.id);
      assert.deepEqual([...defined].sort(), [...OWN_RULES].sort());
    });

    it('every part has valid facets, lanes, a unique name and unique case names', () => {
      for (const { id, part } of laneParts()) {
        assert.match(part.name, /^[A-Za-z][A-Za-z0-9-]*$/, `${id}.${part.name}`);
        assert.ok(part.facets.length > 0 && part.facets.every((f) => Object.hasOwn(FACETS, f)), `${id}.${part.name} facets`);
        assert.ok(part.cases.length > 0, `${id}.${part.name} has cases`);
        const names = part.cases.map((c) => c.name);
        assert.equal(new Set(names).size, names.length, `${id}.${part.name}: case names are unique`);
      }
    });

    it('every world passes the validator and instantiates', () => {
      const problems: string[] = [];
      for (const { id, part } of laneParts()) {
        for (const c of part.cases) {
          problems.push(...validateCase(c, part.world).map((p) => `${id}.${part.name} ${p}`));
          assert.doesNotThrow(() => instantiateWorld((c.world ?? part.world)!), `${id}.${part.name} ${c.name}`);
        }
      }
      assert.deepEqual(problems, []);
    });

    it('lane worlds carry their lane data', () => {
      const lane = (sel: string) => lanePart(sel)!.cases.map((c) => (c.world ?? lanePart(sel)!.world)!.lane);
      for (const l of lane('B10.http')) assert.ok(l?.http?.routes?.length);
      for (const l of lane('B20.orm')) assert.ok(l?.orm?.models.length);
      for (const l of lane('B28.fs')) assert.ok(l?.fs?.providers.length);
      for (const l of lane('B30.queue')) assert.ok(l?.queue?.jobs?.length);
    });
  });

  describe('runner registration', () => {
    const facets: Facet[] = ['engine', 'host', 'audit', 'boot', 'cache', 'bus', 'rbac', 'admin', 'store', 'http', 'orm', 'fs', 'queue', 'token', 'authn', 'impersonation', 'configuration', 'socket', 'email'];
    const harness = (f: readonly Facet[]): BehaviourHarness => ({ facets: f, setup: async () => ({ dispose: async () => undefined }) });

    it('registers each lane part with its facets and lanes, one test per case titled with the part id', () => {
      const rec = recorder();
      runBehaviour([...OWN_RULES, ...FILLED] as never, () => harness(facets), { mocha: rec.mocha, fixtures: BEHAVIOUR_FIXTURES });
      for (const { id, part } of laneParts()) {
        const suite = `${id}.${part.name} [${part.facets.join(', ')}]${part.lanes.length ? ` (${part.lanes.join(', ')})` : ''}`;
        assert.ok(
          rec.suites.some((s) => s[s.length - 1] === suite),
          `suite ${suite}`,
        );
        const titles = rec.tests.filter((t) => t.path[t.path.length - 1] === suite).map((t) => t.title);
        assert.deepEqual(
          titles,
          part.cases.map((c) => `${id}.${part.name} ${c.name}`),
        );
      }
    });

    it('a harness without the lane facet leaves the part pending, naming the facet', () => {
      const rec = recorder();
      runBehaviour(['B10'], () => harness(['engine', 'rbac']), { mocha: rec.mocha, fixtures: BEHAVIOUR_FIXTURES });
      const pending = rec.tests.find((t) => t.title.startsWith('B10.http'))!;
      assert.equal(pending.fn, undefined);
      assert.match(pending.title, /lacks facets http/);
    });
  });

  describe('steps call the lane handles as specified (stub harness)', () => {
    interface Call {
      readonly what: string;
      readonly as: string;
      readonly args: unknown;
    }

    /** Records every lane call with the ALS principal at that moment; `answer` scripts http responses. */
    function stubHarness(answer: (req: HttpRequest) => HttpResponse = () => ({ status: 599, body: null })) {
      const calls: Call[] = [];
      const harness: BehaviourHarness = {
        facets: ['engine', 'host', 'audit', 'http', 'orm', 'fs', 'queue'],
        async setup(world) {
          const kit = instantiateWorld(world);
          const als = new AsyncLocalStorage<Principal>();
          const current = () => als.getStore() ?? UNATTENDED;
          const decision = (principal: Principal): Decision => ({ allowed: false, permission: 'x:y', resource: { type: 'x' }, principal, residual: FALSE, fields: { read: [], write: [] }, roles: {}, domain: 'root' });
          const authz: BehaviourAuthz = {
            check: async (req) => decision(req.principal),
            checkMany: async () => new Map(),
            explain: async (req) => decision(req.principal),
            current,
            runAs: (p, _reason, fn) => als.run(p, fn),
          };
          const record = (what: string, args: unknown) => calls.push({ what, as: principalKey(current()), args });
          const lane: Partial<LaneHandles> = {
            http: {
              request: async (req) => (record('http', { method: req.method, path: req.path, principal: req.principal ? principalKey(req.principal) : null }), answer(req)),
              logs: () => [],
            },
            orm: { run: async (q: OrmQuery) => (record('orm', q), { sql: [] }), rows: async () => [] },
            fs: { call: async (fs: string, method: string, args: readonly FsArg[]) => (record('fs', { fs, method, args }), undefined), isRaw: () => false },
            queue: {
              emit: async (job) => (record('emit', job), { job }),
              handle: async (m: QueueMessage) => (record('handle', m.job), { principal: current(), decisions: [] }),
              peer: async () => assert.fail('no peer'),
            },
          };
          return { authz, kit, audit: kit.audit, domains: { service: () => authz, names: () => [], dispose: async () => undefined }, lane, dispose: async () => undefined };
        },
      };
      return { harness, calls };
    }

    const runParts = async (selectors: readonly string[], h: BehaviourHarness) => {
      const rec = recorder();
      runBehaviour(selectors as never, () => h, { mocha: rec.mocha, fixtures: BEHAVIOUR_FIXTURES });
      return rec.run();
    };

    it('http steps send each request of B10.http with the resolved principal', async () => {
      const { harness, calls } = stubHarness();
      await runParts(['B10.http'], harness);
      assert.deepEqual(
        calls.map((c) => c.args),
        [
          { method: 'GET', path: '/files/f1', principal: null },
          { method: 'GET', path: '/files/f1', principal: null },
          { method: 'GET', path: '/public/f1', principal: null },
          { method: 'GET', path: '/public/f1', principal: null },
          { method: 'GET', path: '/files/f1', principal: 'user:alice' },
        ],
      );
    });

    it('a B10.http case passes when the app answers as the design says, and fails otherwise', async () => {
      const right = stubHarness((req) => (req.principal ? { status: 200, body: { principal: { type: 'user', id: 'alice' } } } : { status: 401, body: {} }));
      const results = await runParts(['B10.http'], right.harness);
      const state = Object.fromEntries(results.map((r) => [r.title, r.state]));
      assert.equal(state['B10.http @Access without @AllowAnonymous answers an anonymous request 401 before any model runs'], 'passed');
      assert.equal(state['B10.http with anonymous disabled, an @Access route answers 401 before any model runs'], 'passed');
      const wrong = stubHarness(() => ({ status: 403, body: {} }));
      for (const r of await runParts(['B10.http'], wrong.harness)) assert.equal(r.state, 'failed', r.title);
    });

    it('orm steps run each query of B20.orm inside runAs of the case principal', async () => {
      const { harness, calls } = stubHarness();
      await runParts(['B20.orm'], harness);
      const first = calls.find((c) => c.what === 'orm')!;
      assert.deepEqual(first, { what: 'orm', as: 'user:alice', args: { op: 'select', model: 'Task', accessible: 'task:read' } });
      assert.ok(calls.some((c) => matches(c.args, { op: 'update', model: 'Task', accessible: 'task:update' })));
      assert.ok(calls.some((c) => (c.args as OrmQuery).op === 'insert' && (c.args as { values: { id: string } }).values.id === 't9'));
    });

    it('fs steps of B28.fs call the guarded filesystem as the case principal, or without one', async () => {
      const { harness, calls } = stubHarness();
      await runParts(['B28.fs'], harness);
      const fs = calls.filter((c) => c.what === 'fs');
      assert.ok(fs.some((c) => c.as === 'user:alice' && matches(c.args, { fs: 'uploads', method: 'copy', args: ['docs/a.txt', 'copy.txt'] })));
      assert.ok(fs.some((c) => c.as === 'system:system' && matches(c.args, { fs: 'uploads', method: 'zip', args: [['docs/b.txt'], { fs: 'uploads' }, 'arch.zip'] })));
      assert.ok(fs.some((c) => c.as === 'unattended:unattended' && matches(c.args, { fs: 'uploads', method: 'tmpname' })));
    });

    it('queue steps emit inside runAs and handle outside any ALS', async () => {
      const { harness, calls } = stubHarness();
      await runParts(['B30.queue'], harness);
      assert.ok(calls.some((c) => c.what === 'emit' && c.as === 'user:alice'));
      assert.ok(calls.some((c) => c.what === 'emit' && c.as === 'system:system'));
      const handles = calls.filter((c) => c.what === 'handle');
      assert.ok(handles.length > 0 && handles.every((c) => c.as === 'unattended:unattended'));
    });
  });

  describe('step helpers', () => {
    const alice = userPrincipal('alice');
    const world: World = { permissions: ['file:read'], principals: { alice }, combine: combine('deny-overrides') };

    function ctx(lane: Partial<LaneHandles>, extra: Partial<HarnessSession> = {}): StepContext {
      const session: HarnessSession = { lane, dispose: async () => undefined, ...extra };
      return {
        session,
        world,
        domain: session.domain ?? 'root',
        authz: () => session.authz!,
        principal: (who) => resolvePrincipal(world, who),
        rows: () => [],
        subject: async () => undefined,
        select: async () => [],
        staticModel: () => assert.fail('no kit'),
      };
    }
    const run = async (step: Step | Step[], c: StepContext) => {
      for (const s of Array.isArray(step) ? step : [step]) await (s as DoStep).do(c);
    };
    const fails = (step: Step, c: StepContext, re: RegExp) => assert.rejects(run(step, c), re);

    const httpCtx = (res: HttpResponse, seen: HttpRequest[] = []) => ctx({ http: { request: async (r) => (seen.push(r), res), logs: () => [] } });

    it('http: sends method, path, principal and body; checks status, body pattern, absent and none', async () => {
      const seen: HttpRequest[] = [];
      const c = httpCtx({ status: 200, body: { a: 1, list: [{ n: 'x', k: 1 }], nested: { b: 2 } } }, seen);
      await run(http({ method: 'POST', path: '/p', as: 'alice', body: { q: 1 } }, { status: 200, body: { list: [{ n: 'x' }], nested: {} }, absent: ['zz', 'nested.c'], none: [{ at: 'list', match: { n: 'y' } }] }), c);
      assert.equal(seen[0].principal, alice);
      assert.deepEqual({ ...seen[0], principal: undefined }, { method: 'POST', path: '/p', body: { q: 1 }, principal: undefined });
      await run(http({ method: 'GET', path: '/p' }, { status: [201, 200] }), c);
      await run(http({ method: 'GET', path: '/p' }, { status: { not: 404 } }), c);
      assert.equal(seen[2].principal, undefined);
      await fails(http({ method: 'GET', path: '/p' }, { status: 403 }), c, /status 200/);
      await fails(http({ method: 'GET', path: '/p' }, { status: 200, body: { a: 2 } }), c, /does not match/);
      await fails(http({ method: 'GET', path: '/p' }, { status: 200, absent: ['nested.b'] }), c, /nested.b is present/);
      await fails(http({ method: 'GET', path: '/p' }, { status: 200, none: [{ at: 'list', match: { n: 'x' } }] }), c, /has an element matching/);
      await fails(http({ method: 'GET', path: '/p' }, { status: { not: 200 } }), c, /status 200/);
    });

    it('matches: objects are subsets, arrays are containment, scalars deep-equal', () => {
      assert.ok(matches({ a: 1, b: [1, 2, 3] }, { b: [3, 1] }));
      assert.ok(!matches({ a: 1 }, { a: 1, b: undefined }));
      assert.ok(!matches([1, 2], [3]));
      assert.ok(!matches('1', 1));
      assert.ok(matches({ d: { e: [{ f: 1, g: 2 }] } }, { d: { e: [{ g: 2 }] } }));
    });

    it('orm: runs the query, compares ids, count, access and the thrown reason', async () => {
      const seen: OrmQuery[] = [];
      const access = { a: { 'task:update': true }, b: { 'task:update': false } };
      const res = { ids: ['b', 'a'], count: 2, sql: ['select 1'], access };
      const c = ctx({ orm: { run: async (q) => (seen.push(q), res), rows: async () => [{ id: 't1', title: 'a', owner: 'alice' }] } });
      const q = { op: 'select', model: 'Task', accessible: 'task:read', withAccess: ['task:update'] } as const;
      await run(orm(q, { ids: ['a', 'b'], count: 2, access }), c);
      assert.deepEqual(seen, [q]);
      await fails(orm(q, { access: { a: { 'task:update': true } } }), c, /access/);
      await fails(orm(q, { ids: ['a'] }), c, /ids/);
      await fails(orm(q, { throws: 'AccessDenied' }), c, /expected a throw of AccessDenied/);
      await run(ormRows('Task', { ids: ['t1'], rows: [{ id: 't1', owner: 'alice' }] }), c);
      await fails(ormRows('Task', { rows: [{ id: 't1', owner: 'bob' }] }), c, /row t1/);

      const denied = new AccessDenied({ allowed: false, permission: 'task:read', resource: { type: 'task' }, principal: UNATTENDED, residual: FALSE, fields: { read: [], write: [] }, roles: {}, domain: 'root', reason: { code: 'unattended' } });
      const d = ctx({ orm: { run: async () => Promise.reject(denied), rows: async () => [] } });
      await run(orm(q, { throws: 'AccessDenied', reason: 'unattended' }), d);
      await run(orm(q, { throws: 'Forbidden' }), d);
      await fails(orm(q, { throws: 'AccessDenied', reason: 'no_access' }), d, /decision.reason.code/);
      await assert.rejects(run(orm(q, {}), d), /Access denied/);
    });

    it('fs: calls the method with its args, and reads raw', async () => {
      const seen: unknown[] = [];
      const c = ctx({ fs: { call: async (fs, method, args) => void seen.push([fs, method, args]), isRaw: (fs) => fs === 'plain' } });
      await run([fsCall('uploads', 'copy', ['a', 'b'], 'resolves'), fsRaw('plain', true), fsRaw('uploads', false)], c);
      assert.deepEqual(seen, [['uploads', 'copy', ['a', 'b']]]);
      await fails(fsRaw('uploads', true), c, /raw/);
      await fails(fsCall('uploads', 'read', ['a'], { throws: 'AccessDenied' }), c, /expected a throw/);
    });

    it('queue: emitted keeps the message for handled within one session only', async () => {
      const handledMessages: QueueMessage[] = [];
      const queue: LaneHandles['queue'] = {
        emit: async (job) => ({ job, Initiator: { type: 'user', id: 'alice', ceiling: { permissions: ['file:read'] } } }),
        handle: async (m) => (handledMessages.push(m), { principal: alice, decisions: [{ allowed: true, permission: 'file:read', resource: { type: 'file' }, principal: alice, residual: TRUE, fields: { read: [], write: [] }, roles: {}, domain: 'root' }] }),
        peer: async () => assert.fail('no peer'),
      };
      const c = ctx({ queue });
      await run([emitted('m', 'export', { type: 'user', id: 'alice', ceiling: { permissions: ['file:read'] } }), handled('m', { principal: alice, decisions: [{ allowed: true }] })], c);
      assert.equal(handledMessages[0].job, 'export');
      await fails(emitted('m', 'export', null), c, /Initiator/);
      await fails(handled('m', { principal: SYSTEM }), c, /principal/);
      await fails(handled('m', { principal: alice, decisions: [{ allowed: false }] }), c, /allowed/);
      await fails(handled('m', { principal: alice }), ctx({ queue }), /no value "m"/);
    });

    it('token and flow keep the principal they yield for later checks', async () => {
      const agent: Principal = { type: 'agent', id: 'tok1', authenticated: true, source: 'token', attributes: {}, onBehalfOf: alice, delegation: 'inherit', ceiling: { permissions: ['file:read'], reason: 'out_of_scope' } };
      const checked: Principal[] = [];
      const authz = {
        check: async (req: { principal: Principal }) => (checked.push(req.principal), { allowed: true, permission: 'file:read', resource: { type: 'file' }, principal: alice, actor: agent, residual: TRUE, fields: { read: [], write: [] }, roles: {}, domain: 'root' }),
      } as unknown as BehaviourAuthz;
      const owners: Principal[] = [];
      const c = ctx({ token: { principal: async (req) => (owners.push(req.owner), agent) } }, { authz });
      await run([token('a', { owner: 'alice', scope: { agent: true } }, { type: 'agent', onBehalfOf: alice, delegation: 'inherit', ceiling: { reason: 'out_of_scope' } }), checkKept('a', { permission: 'file:read' }, { allowed: true }), actorIsKept('a', { permission: 'file:read' })], c);
      assert.equal(owners[0], alice);
      assert.deepEqual(checked, [agent, agent]);
      await fails(token('b', { owner: 'alice' }, { delegation: 'intersect' }), c, /delegation/);
      await fails(token('b', { owner: 'alice' }, { ceilingKeys: ['permissions'] }), c, /ceiling keys/);

      const body = { Access: { principal: { type: 'user', id: 'alice' } } };
      const requests: HttpRequest[] = [];
      const f = ctx(
        {
          authn: { flow: async (x) => ({ status: 200, body, principal: x.as }) },
          http: { request: async (r) => (requests.push(r), { status: 200, body: { principal: { type: 'user', id: 'alice' } } }), logs: () => [] },
        },
        { authz },
      );
      await run([flow('login', { kind: 'login', as: 'alice' }, { principal: { type: 'user', id: 'alice' } }), accessOfFlow('login')], f);
      assert.deepEqual(
        requests.map((r) => [r.method, r.path, r.principal]),
        [['GET', '/user/access', alice]],
      );
      const g = ctx({ authn: { flow: async () => ({ status: 200, body: { Access: { other: 1 } }, principal: alice }) }, http: { request: async () => ({ status: 200, body: { principal: {} } }), logs: () => [] } });
      await run(flow('login', { kind: 'login', as: 'alice' }), g);
      await fails(accessOfFlow('login'), g, /Access differs/);
    });

    it('store: version bumps, in the session domain unless one is named', async () => {
      const versions: Record<string, number> = { root: 1, test: 1 };
      const asked: string[] = [];
      const store = { version: async (d: string) => (asked.push(d), String(versions[d])) };
      const c = ctx({ store });
      await run(versionAs('v'), c);
      versions.root++;
      await run(versionChanged('v', true), c);
      await fails(versionChanged('v', false), c, /authz_version\(root\)/);

      const t = ctx({ store }, { domain: 'test' });
      await run(versionAs('v'), t);
      versions.root++;
      await run(versionChanged('v', false), t);
      versions.test++;
      await fails(versionChanged('v', false), t, /authz_version\(test\)/);
      await run([versionAs('w', 'root'), versionChanged('w', false, 'root')], t);
      const h = ctx({ store });
      const hc = { ...h, domain: 'test' };
      await run(versionAs('x'), hc);
      versions.test++;
      await run(versionChanged('x', true), hc);
      assert.deepEqual(asked, ['root', 'root', 'root', 'test', 'test', 'test', 'root', 'root', 'test', 'test']);
    });

    it('tracesOnlyAtDebug: a trace at debug, none above', async () => {
      const at = (logs: { level: string; trace: boolean }[]) => ctx({ http: { request: async () => ({ status: 200, body: null }), logs: () => logs.map((l) => ({ ...l, message: 'm' })) } });
      await run(
        tracesOnlyAtDebug(),
        at([
          { level: 'debug', trace: true },
          { level: 'info', trace: false },
        ]),
      );
      await fails(tracesOnlyAtDebug(), at([{ level: 'info', trace: false }]), /no debug log record/);
      await fails(
        tracesOnlyAtDebug(),
        at([
          { level: 'debug', trace: true },
          { level: 'warn', trace: true },
        ]),
        /above debug/,
      );
    });

    it('a missing lane handle fails with its name', async () => {
      await fails(http({ method: 'GET', path: '/' }, { status: 200 }), ctx({}), /no lane handle "http"/);
      assert.equal(as('alice').runAs.as, 'alice');
    });
  });

  describe('package exports', () => {
    type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
    type Expect<T extends true> = T;

    it('the package root exports the lane types and the step helpers', () => {
      const typeChecks: [Expect<Equals<NonNullable<World['lane']>, LaneWorld>>, Expect<Equals<LaneHandles['http'], HttpHandle>>, Expect<'impersonationGuard' extends keyof LaneHandles ? true : false>, Expect<'ceilingKeys' extends keyof TokenPrincipalExpectation ? true : false>] = [true, true, true, true];
      assert.ok(typeChecks.every(Boolean));
      assert.equal(laneSteps.http, http);
      assert.equal(typeof modelSteps.exec, 'function');
    });

    // The test program also compiles lane.ts through other imports, so only a program built from the
    // published declarations alone shows what a consumer sees (catalogue.d.ts does not import the lanes).
    describe('a consumer of the built declarations (lib/mjs, built by pretest)', () => {
      const dir = fileURLToPath(new URL('.', import.meta.url)).replace(/\\/g, '/');
      const probe = `${dir}consumer-probe.ts`;

      function diagnostics(text: string): string[] {
        const options: ts.CompilerOptions = { module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16, target: ts.ScriptTarget.ES2021, strict: true, noEmit: true, skipLibCheck: true, types: ['node'] };
        const host = ts.createCompilerHost(options);
        const isProbe = (name: string) => name.replace(/\\/g, '/').toLowerCase() === probe.toLowerCase();
        const { getSourceFile, fileExists, readFile } = host;
        host.getSourceFile = (name, lang, ...rest) => (isProbe(name) ? ts.createSourceFile(name, text, lang) : getSourceFile.call(host, name, lang, ...rest));
        host.fileExists = (name) => isProbe(name) || fileExists.call(host, name);
        host.readFile = (name) => (isProbe(name) ? text : readFile.call(host, name));
        const program = ts.createProgram([probe], options, host);
        return ts.getPreEmitDiagnostics(program, program.getSourceFile(probe)).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      }

      const IMPORTS = `import type { HttpHandle, LaneHandles, LaneWorld, OrmModelSpec, TokenPrincipalExpectation, World } from '../../lib/mjs/index.js';\nimport { laneSteps, modelSteps } from '../../lib/mjs/index.js';\n`;

      it('sees World.lane, every lane handle key and the step namespaces', function () {
        this.timeout(120_000);
        const found = diagnostics(
          IMPORTS +
            `const lane: LaneWorld = { orm: { models: [{ name: 'Org', type: 'org', columns: ['parent_id'], parents: [{ column: 'parent_id', type: 'org', nullable: true }] } satisfies OrmModelSpec] } };
export const world: World = { permissions: [], combine: { default: { algorithm: 'deny-overrides', models: [] } }, lane };
export const keys: (keyof LaneHandles)[] = ['http', 'orm', 'fs', 'queue', 'token', 'authn', 'store', 'configuration', 'socket', 'email', 'impersonationGuard'];
export const handle: HttpHandle | undefined = ({} as Partial<LaneHandles>).http;
export const guard: LaneHandles['impersonationGuard'] | undefined = undefined;
export const expectation: TokenPrincipalExpectation = { ceilingKeys: [] };
export const step = laneSteps.http({ method: 'GET', path: '/' }, { status: 200 });
export const ms: object = modelSteps;
`,
        );
        assert.deepEqual(found, []);
      });

      it('reports a lane handle key that does not exist (control)', function () {
        this.timeout(120_000);
        const found = diagnostics(IMPORTS + `export const key: keyof LaneHandles = 'nope';\nexport type Unused = [HttpHandle, LaneWorld, OrmModelSpec, TokenPrincipalExpectation, World, typeof laneSteps, typeof modelSteps];\n`);
        assert.ok(
          found.some((d) => d.includes('"nope"')),
          JSON.stringify(found),
        );
      });
    });
  });
});
