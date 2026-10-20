import assert from 'node:assert/strict';
import 'mocha';

import { AuthzConfigError, FALSE, TRUE } from '@spinajs/authz';
import type { Decision } from '@spinajs/authz';

import { fixtureDsl, instantiateWorld, mergeFixtures, runBehaviour } from '../../src/index.js';
import type { BehaviourAuthz, BehaviourFixture, BehaviourHarness, Case, Facet, FixtureExtension, HarnessSession, SetupContext, World } from '../../src/index.js';
import { recorder } from './recorder.js';

const { combine, extension, fixture } = fixtureDsl;

const world: World = { permissions: ['file:read'], combine: combine('deny-overrides') };

const decision = (allowed: boolean): Decision => ({ allowed, permission: 'file:read', resource: { type: 'file' }, principal: { type: 'user', id: 'u' }, residual: allowed ? TRUE : FALSE, fields: { read: [], write: [] }, roles: {}, domain: 'root' });

const stubAuthz: BehaviourAuthz = {
  check: async () => decision(true),
  checkMany: async () => new Map(),
  explain: async () => decision(true),
};

interface Stub extends BehaviourHarness {
  readonly log: string[];
}

/** Records setup and dispose; `setupError` makes setup reject. */
function stub(facets: readonly Facet[] = ['engine'], opts: { setupError?: Error; session?: Partial<HarnessSession>; hooks?: boolean } = {}): Stub {
  const log: string[] = [];
  return {
    facets,
    log,
    ...(opts.hooks
      ? {
          beforeAll: async () => void log.push('beforeAll'),
          afterAll: async () => void log.push('afterAll'),
        }
      : {}),
    async setup(w: World, ctx: SetupContext): Promise<HarnessSession> {
      log.push(`setup ${ctx.title}`);
      if (opts.setupError) throw opts.setupError;
      return { authz: stubAuthz, kit: instantiateWorld(w), ...opts.session, dispose: async () => void log.push(`dispose ${ctx.title}`) };
    },
  };
}

const ok: Case = { name: 'passes', world, steps: [{ do: () => undefined }] };
const boom: Case = {
  name: 'fails',
  world,
  steps: [
    {
      do: () => {
        throw new Error('boom');
      },
    },
  ],
};

const FIXTURES: readonly (BehaviourFixture | FixtureExtension)[] = [
  fixture('B01', [
    { name: 'core', facets: ['engine'], lanes: ['F3'], cases: [ok, boom] },
    { name: 'http', facets: ['engine', 'http'], lanes: ['L5'], cases: [ok] },
    { name: 'later', facets: ['engine'], lanes: [], note: 'L9 proposes them', cases: [] },
  ]),
  fixture('B02', [{ name: 'core', facets: ['engine'], lanes: [], cases: [ok] }]),
];

function register(ids: Parameters<typeof runBehaviour>[0], harness: BehaviourHarness, opts: { strict?: boolean; fixtures?: readonly (BehaviourFixture | FixtureExtension)[] } = {}) {
  const rec = recorder();
  runBehaviour(ids, () => harness, { mocha: rec.mocha, fixtures: opts.fixtures ?? FIXTURES, strict: opts.strict });
  return rec;
}

const state = async (rec: ReturnType<typeof recorder>) => Object.fromEntries((await rec.run()).map((r) => [r.title, r.state]));

describe('runBehaviour', () => {
  it('registers one describe per fixture and per part and one test per case, titled with the id', () => {
    const rec = register('B01', stub());
    assert.deepEqual(
      rec.tests.filter((t) => t.fn).map((t) => t.title),
      ['B01.core passes', 'B01.core fails'],
    );
    const core = rec.tests.find((t) => t.title === 'B01.core passes')!;
    assert.equal(core.path.length, 3);
    assert.ok(core.path[1].startsWith('B01 No routed model permits'));
    assert.ok(core.path[2].startsWith('B01.core [engine] (F3)'));
    for (const t of rec.tests) assert.ok(t.title.startsWith('B01.'), t.title);
  });

  it('a part the harness lacks facets for is pending through the bare id, naming the facets', async () => {
    const rec = register('B01', stub());
    const http = rec.tests.find((t) => t.title.startsWith('B01.http'))!;
    assert.equal(http.fn, undefined);
    assert.match(http.title, /lacks facets http/);
    assert.equal((await state(rec))[http.title], 'pending');
  });

  it('named by its part id, such a part fails naming the missing facets', async () => {
    const rec = register(['B01.http'], stub());
    const results = await rec.run();
    assert.equal(results.length, 1);
    assert.equal(results[0].state, 'failed');
    assert.match(results[0].error!.message, /needs facets engine, http; the harness lacks facets http/);
  });

  it('strict turns pending parts (missing facets, no cases) into failures', async () => {
    const results = await register('B01', stub(), { strict: true }).run();
    const byTitle = Object.fromEntries(results.map((r) => [r.title.split(' ')[0], r]));
    assert.equal(byTitle['B01.http'].state, 'failed');
    assert.equal(byTitle['B01.later'].state, 'failed');
    assert.match(byTitle['B01.later'].error!.message, /no cases yet: L9 proposes them/);
  });

  it('a part without cases is pending with its note', async () => {
    const rec = register('B01', stub());
    const later = rec.tests.find((t) => t.title.startsWith('B01.later'))!;
    assert.equal(later.fn, undefined);
    assert.match(later.title, /no cases yet: L9 proposes them/);
  });

  it('runs only the named part when a part id is given', () => {
    const rec = register(['B01.core', 'B02'], stub());
    assert.deepEqual(
      rec.tests.map((t) => t.title),
      ['B01.core passes', 'B01.core fails', 'B02.core passes'],
    );
  });

  it('throws at registration for unknown ids and parts, before calling the factory', () => {
    for (const bad of ['B47', 'B1', 'X01', 'B01.nope', 'B01.', 'b01']) {
      let called = false;
      assert.throws(() => runBehaviour([bad as never], () => ((called = true), stub()), { mocha: recorder().mocha, fixtures: FIXTURES }), /unknown behaviour id|has no part/, bad);
      assert.equal(called, false, bad);
    }
  });

  it('throws at registration for an empty id list', () => {
    assert.throws(() => runBehaviour([], () => stub(), { mocha: recorder().mocha, fixtures: FIXTURES }), /no behaviour ids/);
  });

  it('a known id without fixture parts gets a failing test', async () => {
    const results = await register('B11', stub()).run();
    assert.equal(results.length, 1);
    assert.equal(results[0].state, 'failed');
    assert.match(results[0].title, /^B11 has no fixture parts yet/);
  });

  it('calls the factory once, sets up each case and disposes it, also when the case fails', async () => {
    let made = 0;
    const harness = stub();
    const rec = recorder();
    runBehaviour(['B01.core', 'B02.core'], () => (made++, harness), { mocha: rec.mocha, fixtures: FIXTURES });
    const results = await rec.run();
    assert.equal(made, 1);
    assert.deepEqual(
      results.map((r) => r.state),
      ['passed', 'failed', 'passed'],
    );
    assert.match(results[1].error!.message, /step 0 \(do\): boom/);
    assert.deepEqual(harness.log, ['setup B01.core passes', 'dispose B01.core passes', 'setup B01.core fails', 'dispose B01.core fails', 'setup B02.core passes', 'dispose B02.core passes']);
  });

  it('runs beforeAll and afterAll once around the cases', async () => {
    const harness = stub(['engine'], { hooks: true });
    await register(['B02'], harness).run();
    assert.deepEqual(harness.log, ['beforeAll', 'setup B02.core passes', 'dispose B02.core passes', 'afterAll']);
  });

  it('fails a case whose session misses the handle of a facet the part needs', async () => {
    const harness: BehaviourHarness = { facets: ['engine'], setup: async () => ({ authz: stubAuthz, dispose: async () => undefined }) };
    const results = await register(['B02.core'], harness).run();
    assert.equal(results[0].state, 'failed');
    assert.match(results[0].error!.message, /misses the handle of facet engine/);
  });

  describe('boot expectations', () => {
    const bootCase = (orAtCall = false): Case => ({
      name: 'refused',
      world,
      boot: { throws: 'AuthzConfigError', message: ['root'], orAtCall },
      steps: [{ check: { as: { type: 'user', id: 'u', authenticated: true, source: 'test', attributes: {} }, permission: 'file:read' }, expect: { throws: 'AuthzConfigError' } }],
    });
    const run = (harness: BehaviourHarness, c: Case) => register(['B05.core'], harness, { fixtures: [fixture('B05', [{ name: 'core', facets: ['engine'], lanes: [], cases: [c] }])] }).run();

    it('passes when setup rejects with the expected error and message', async () => {
      const [r] = await run(stub(['engine'], { setupError: new AuthzConfigError('[root] bad') }), bootCase());
      assert.equal(r.state, 'passed');
    });

    it('fails when setup rejects with another error or message', async () => {
      assert.equal((await run(stub(['engine'], { setupError: new Error('[root] bad') }), bootCase()))[0].state, 'failed');
      assert.equal((await run(stub(['engine'], { setupError: new AuthzConfigError('[child] bad') }), bootCase()))[0].state, 'failed');
    });

    it('fails when setup succeeds, and disposes the session', async () => {
      const harness = stub();
      const [r] = await run(harness, bootCase());
      assert.equal(r.state, 'failed');
      assert.match(r.error!.message, /setup was expected to reject with AuthzConfigError/);
      assert.deepEqual(harness.log, ['setup B05.core refused', 'dispose B05.core refused']);
    });

    it('$domain in a boot message stands for the harness domain', async () => {
      const domainCase: Case = { ...bootCase(), boot: { throws: 'AuthzConfigError', message: ['[$domain]'] } };
      const harness = (message: string): BehaviourHarness => ({ ...stub(['engine'], { setupError: new AuthzConfigError(message) }), domain: 'test' });
      assert.equal((await run(harness('[test] bad'), domainCase))[0].state, 'passed');
      assert.equal((await run(harness('[root] bad'), domainCase))[0].state, 'failed');
      assert.equal((await run(stub(['engine'], { setupError: new AuthzConfigError('[root] bad') }), domainCase))[0].state, 'passed', 'default root');
    });

    it('with orAtCall, a successful setup passes when the steps throw as expected', async () => {
      const throwing: BehaviourAuthz = {
        ...stubAuthz,
        check: async () => {
          throw new AuthzConfigError('at call');
        },
      };
      assert.equal((await run(stub(['engine'], { session: { authz: throwing } }), bootCase(true)))[0].state, 'passed');
      assert.equal((await run(stub(), bootCase(true)))[0].state, 'failed');
    });
  });
});

describe('$domain in step expectations', () => {
  const user = { type: 'user', id: 'u', authenticated: true, source: 'test', attributes: {} };
  const throwing = (message: string): BehaviourAuthz => ({
    ...stubAuthz,
    check: async () => {
      throw new AuthzConfigError(message);
    },
  });
  const run = async (session: Partial<HarnessSession>, c: Case) => (await register(['B01.core'], stub(['engine'], { session }), { fixtures: [fixture('B01', [{ name: 'core', facets: ['engine'], lanes: [], cases: [c] }])] }).run())[0].state;

  it('stands for session.domain in a thrown message and in DecisionExpectation.domain', async () => {
    const thrown: Case = { name: 'thrown', world, steps: [{ check: { as: user, permission: 'file:read' }, expect: { throws: 'AuthzConfigError', message: ['[$domain]'] } }] };
    assert.equal(await run({ authz: throwing('[t1] x'), domain: 't1' }, thrown), 'passed');
    assert.equal(await run({ authz: throwing('[root] x'), domain: 't1' }, thrown), 'failed');
    const decided: Case = { name: 'decided', world, steps: [{ check: { as: user, permission: 'file:read' }, expect: { domain: '$domain' } }] };
    assert.equal(await run({ domain: 'root' }, decided), 'passed');
    assert.equal(await run({ domain: 't1' }, decided), 'failed');
  });
});

describe('mergeFixtures', () => {
  const declared = fixture('B07', [
    { name: 'core', facets: ['engine'], lanes: [], cases: [ok] },
    { name: 'token', facets: ['token'], lanes: ['C5'], cases: [] },
  ]);

  it('an extension adds parts and fills a declared part that has no cases', () => {
    const merged = mergeFixtures([declared, extension('B07', [{ name: 'token', facets: ['token'], lanes: ['C5'], cases: [ok] }]), extension('B07', [{ name: 'extra', facets: ['engine'], lanes: [], cases: [ok] }])]).get('B07')!;
    assert.deepEqual(
      merged.parts.map((p) => [p.name, p.cases.length]),
      [
        ['core', 1],
        ['token', 1],
        ['extra', 1],
      ],
    );
  });

  it('keeps the part with cases whichever comes first', () => {
    const merged = mergeFixtures([extension('B07', [{ name: 'token', facets: ['token'], lanes: ['C5'], cases: [ok] }]), declared]).get('B07')!;
    assert.deepEqual(
      merged.parts.map((p) => [p.name, p.cases.length]),
      [
        ['token', 1],
        ['core', 1],
      ],
    );
  });

  it('refuses a part defined twice with cases, a fixture defined twice and an unknown id', () => {
    assert.throws(() => mergeFixtures([declared, extension('B07', [{ name: 'core', facets: ['engine'], lanes: [], cases: [ok] }])]), /B07.core is defined twice/);
    assert.throws(() => mergeFixtures([declared, declared]), /B07 is defined twice/);
    assert.throws(() => mergeFixtures([{ id: 'B99' as never, parts: [] }]), /unknown id B99/);
  });

  it('an extension alone takes the rule text of design §17', () => {
    assert.match(mergeFixtures([extension('B11', [])]).get('B11')!.rule, /^RBAC effective roles/);
  });
});
