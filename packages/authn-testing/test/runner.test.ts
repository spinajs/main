import assert from 'node:assert/strict';
import 'mocha';
import { UnsupportedConfig } from '../src/harness/index.js';
import type { Harness, HttpRequest, HttpResponse } from '../src/harness/index.js';
import { RecordingEventSink } from '../src/fakes/index.js';
import { defineCase, defineRule, planCases, runAuthnBehaviour, send, sendRaw, settleCase } from '../src/behaviour/index.js';
import type { AuthnCase, AuthnRule, BddApi, HarnessFactory, RuleId, RunOptions, TestThis } from '../src/behaviour/index.js';
import { MOCHA_SLACK_MS, planCasesIn, runBehaviourIn } from '../src/behaviour/runner.js';
import type { FakeClock } from '../src/fakes/index.js';
import { pending, withSubject } from '../src/conformance/run.js';

const SKIP = Symbol('skip');
const RealDate = Date;

interface Ran {
  readonly title: string;
  readonly status: 'passed' | 'pending' | 'failed';
  readonly error?: unknown;
  readonly timeouts: number[];
  /** Date was the real one right after the case settled. */
  readonly dateReal: boolean;
}

/** A BddApi that records the tree, runs every it in order, then the after hooks. */
async function collect(register: (bdd: BddApi) => void): Promise<{ describes: string[]; ran: Ran[]; logs: string[] }> {
  const describes: string[] = [];
  const its: { title: string; fn: (this: TestThis) => Promise<void> }[] = [];
  const afters: (() => void)[] = [];
  register({ describe: (t, fn) => (describes.push(t), fn()), it: (title, fn) => void its.push({ title, fn }), after: (fn) => void afters.push(fn) });
  const ran: Ran[] = [];
  for (const c of its) {
    const test = { title: c.title };
    const timeouts: number[] = [];
    const self: TestThis = {
      test,
      timeout: (ms) => void timeouts.push(ms),
      skip: () => {
        throw SKIP;
      },
    };
    let outcome: Pick<Ran, 'status' | 'error'>;
    try {
      await c.fn.call(self);
      outcome = { status: 'passed' };
    } catch (error) {
      outcome = error === SKIP ? { status: 'pending' } : { status: 'failed', error };
    }
    ran.push({ title: test.title, ...outcome, timeouts, dateReal: Date === RealDate });
  }
  const logs: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.join(' '));
  try {
    afters.forEach((f) => f());
  } finally {
    console.log = log;
  }
  return { describes, ran, logs };
}

/** Counts lifecycle calls per case. */
class Probe {
  factory = 0;
  dispose = 0;
  close = 0;
  prepare = 0;
  installedInRun: boolean[] = [];
}

const ok = async () => undefined;

function rules(cases: Record<string, AuthnCase[]>): Map<RuleId, AuthnRule> {
  return new Map(Object.entries(cases).map(([id, cs]) => [id as RuleId, defineRule(id as RuleId, `rule ${id}`, cs)]));
}

const RULES = rules({
  A01: [defineCase({ name: 'A01 needs nothing', facet: 'A01/core', needs: [], run: ok }), defineCase({ name: 'A01 needs sessions', facet: 'A01/core', needs: ['sessions', 'events'], run: ok })],
  A03: [defineCase({ name: 'A03 store case', facet: 'A03/argon2', needs: ['events'], run: ok })],
  A04: [],
});

const factory =
  (h: Harness = {}): HarnessFactory =>
  () =>
    h;

describe('runAuthnBehaviour: validation', () => {
  const reg = (ids: string[], opts: RunOptions = {}) => {
    let calls = 0;
    const bdd: BddApi = { describe: () => void calls++, it: () => void calls++, after: () => void calls++ };
    assert.throws(() => runBehaviourIn(RULES, ids as RuleId[], factory(), { ...opts, bdd }));
    assert.strictEqual(calls, 0, 'nothing registered');
  };

  it('throws synchronously, before any registration, on bad ids, claims and facets', () => {
    assert.throws(() => planCases(['A99' as RuleId]), /unknown rule id A99/);
    assert.throws(() => planCases(['A28' as RuleId]), /unknown rule id A28/);
    assert.throws(() => planCases(['a02' as RuleId]), /unknown rule id a02/);
    assert.throws(() => planCases(['A02', 'A02']), /duplicate rule id A02/);
    assert.throws(() => planCases(['A02'], { claim: ['A07/store'] }), /claim\/facet not in the requested rules: A07\/store/);
    assert.throws(() => planCases(['A02'], { facets: ['A02/store'] }), /A02\/store/);
    assert.throws(() => planCases(['A02'], { claim: ['A05'] }), /A05/);
    reg(['A99']);
    reg(['A01', 'A01']);
    reg(['A01'], { claim: ['A03/argon2'] });
    reg(['A01'], { facets: ['A01/http'] });
  });

  it('accepts any facet kind of a rule still pending transcription', () => {
    assert.deepStrictEqual(planCasesIn(RULES, ['A04'], { claim: ['A04/local'], facets: ['A04/local'] }), []);
    assert.throws(() => planCasesIn(RULES, ['A04'], { claim: ['A04/bogus' as never] }));
  });

  it('facets filters the registered cases; claim marks facets and whole rules', () => {
    const p = planCasesIn(RULES, ['A01', 'A03'], { facets: ['A03/argon2'] });
    assert.deepStrictEqual(
      p.map((x) => x.kase.name),
      ['A03 store case'],
    );
    const c = planCasesIn(RULES, ['A01', 'A03'], { claim: ['A01'] });
    assert.deepStrictEqual(
      c.map((x) => x.claimed),
      [true, true, false],
    );
  });
});

describe('runAuthnBehaviour: execution', () => {
  it('registers describe per rule and it per case, and runs a case with its ports', async () => {
    const { describes, ran } = await collect((bdd) => runBehaviourIn(RULES, ['A01', 'A03'], factory({ sessions: {} as never, events: new RecordingEventSink() }), { bdd, title: 'kit' }));
    assert.deepStrictEqual(describes, ['kit', 'A01 rule A01', 'A03 rule A03']);
    assert.deepStrictEqual(
      ran.map((r) => [r.title, r.status]),
      [
        ['A01 needs nothing', 'passed'],
        ['A01 needs sessions', 'passed'],
        ['A03 store case', 'passed'],
      ],
    );
  });

  it('a missing port makes the case pending with the needs in its title and the summary line', async () => {
    const { ran, logs } = await collect((bdd) => runBehaviourIn(RULES, ['A01'], factory({ events: new RecordingEventSink() }), { bdd }));
    assert.deepStrictEqual(
      ran.map((r) => [r.title, r.status]),
      [
        ['A01 needs nothing', 'passed'],
        ['A01 needs sessions [pending: missing sessions]', 'pending'],
      ],
    );
    assert.deepStrictEqual(logs, ['authn-testing pending: A01 needs sessions → sessions']);
  });

  it('AUTHN_TESTING_SUMMARY=off silences the summary', async () => {
    process.env.AUTHN_TESTING_SUMMARY = 'off';
    try {
      const { logs } = await collect((bdd) => runBehaviourIn(RULES, ['A01'], factory(), { bdd }));
      assert.deepStrictEqual(logs, []);
    } finally {
      delete process.env.AUTHN_TESTING_SUMMARY;
    }
  });

  it('a claimed facet with a missing port fails, naming the ports', async () => {
    const { ran } = await collect((bdd) => runBehaviourIn(RULES, ['A01'], factory(), { bdd, claim: ['A01/core'] }));
    assert.strictEqual(ran[1].status, 'failed');
    assert.match(String((ran[1].error as Error).message), /claimed facet A01\/core misses: sessions, events/);
    assert.ok(ran[1].error instanceof assert.AssertionError);
  });

  it('UnsupportedConfig makes the case pending, or failed when claimed', async () => {
    const throwing: HarnessFactory = () => {
      throw new UnsupportedConfig(['authn.local.pepper']);
    };
    const free = await collect((bdd) => runBehaviourIn(RULES, ['A03'], throwing, { bdd }));
    assert.deepStrictEqual(
      free.ran.map((r) => [r.title, r.status]),
      [['A03 store case [pending: missing config:authn.local.pepper]', 'pending']],
    );
    const claimed = await collect((bdd) => runBehaviourIn(RULES, ['A03'], throwing, { bdd, claim: ['A03'] }));
    assert.strictEqual(claimed.ran[0].status, 'failed');
    assert.match((claimed.ran[0].error as Error).message, /misses: config:authn\.local\.pepper/);
  });

  it('pending on fakeDate when the clock is not installed', async () => {
    const r = rules({ A05: [defineCase({ name: 'A05 timed', facet: 'A05/store', needs: ['fakeDate'], run: ok })] });
    const off = await collect((bdd) => runBehaviourIn(r, ['A05'], factory(), { bdd, fakeDate: false }));
    assert.deepStrictEqual(
      off.ran.map((x) => x.status),
      ['pending'],
    );
    assert.strictEqual(off.ran[0].title, 'A05 timed [pending: missing fakeDate]');
    const on = await collect((bdd) => runBehaviourIn(r, ['A05'], factory(), { bdd }));
    assert.deepStrictEqual(
      on.ran.map((x) => x.status),
      ['passed'],
    );
  });

  it('mfa.recovery and route needs resolve from the harness shape', async () => {
    const r = rules({
      A10: [defineCase({ name: 'A10 recovery', facet: 'A10/core', needs: ['mfa', 'mfa.recovery'], run: ok })],
      A07: [defineCase({ name: 'A07 route', facet: 'A07/http', needs: ['http', 'http.routes.login'], run: ok })],
    });
    const plain = { mfa: { step: {} } } as unknown as Harness;
    const recovery = { mfa: { step: { verifyRecovery: ok, regenerateRecoveryCodes: ok } } } as unknown as Harness;
    const noRoute = { http: { routes: {} } } as unknown as Harness;
    const route = { http: { routes: { login: () => ({}) } } } as unknown as Harness;
    const run = async (h: Harness) => (await collect((bdd) => runBehaviourIn(r, ['A10', 'A07'], factory(h), { bdd }))).ran.map((x) => x.title);
    assert.deepStrictEqual(await run(plain), ['A10 recovery [pending: missing mfa.recovery]', 'A07 route [pending: missing http, http.routes.login]']);
    assert.deepStrictEqual(await run(recovery), ['A10 recovery', 'A07 route [pending: missing http, http.routes.login]']);
    assert.deepStrictEqual(await run(noRoute), ['A10 recovery [pending: missing mfa, mfa.recovery]', 'A07 route [pending: missing http.routes.login]']);
    assert.deepStrictEqual((await run(route))[1], 'A07 route');
  });

  it('every case gets a fresh harness; dispose, close and uninstall run once for passing, failing, pending and factory-throwing cases', async () => {
    const probes: Record<string, Probe> = {};
    const mk = (name: string, needs: ('events' | 'sessions')[], body: () => Promise<void>) => {
      const p = (probes[name] = new Probe());
      return defineCase({
        name,
        facet: 'A01/core',
        needs,
        prepare: async () => (p.prepare++, { close: async () => void p.close++ }),
        async run(_h, k) {
          p.installedInRun.push(k.clock.installed && Date.now() === k.clock.now().getTime());
          k.clock.tick(5000);
          p.installedInRun.push(Date.now() === k.clock.now().getTime());
          await body();
        },
      });
    };
    const r = rules({
      A01: [mk('A01 passes', ['events'], ok), mk('A01 fails', ['events'], async () => assert.fail('boom')), mk('A01 pending', ['sessions'], ok), mk('A01 factory throws', ['events'], ok)],
    });
    const f: HarnessFactory = (ctx) => {
      const p = probes[ctx.caseName];
      p.factory++;
      if (ctx.caseName === 'A01 factory throws') {
        throw new Error('factory broke');
      }
      return { events: new RecordingEventSink(), dispose: async () => void p.dispose++ };
    };
    const { ran } = await collect((bdd) => runBehaviourIn(r, ['A01'], f, { bdd }));
    assert.deepStrictEqual(
      ran.map((x) => x.status),
      ['passed', 'failed', 'pending', 'failed'],
    );
    assert.match((ran[3].error as Error).message, /factory broke/);
    for (const name of ['A01 passes', 'A01 fails', 'A01 pending']) {
      assert.deepStrictEqual({ ...probes[name], installedInRun: [] }, { factory: 1, dispose: 1, close: 1, prepare: 1, installedInRun: [] }, name);
    }
    assert.deepStrictEqual([probes['A01 factory throws'].factory, probes['A01 factory throws'].dispose, probes['A01 factory throws'].close], [1, 0, 1]);
    assert.deepStrictEqual(probes['A01 passes'].installedInRun, [true, true]);
    assert.deepStrictEqual(
      ran.map((x) => x.dateReal),
      [true, true, true, true],
      'the clock is uninstalled after every case',
    );
  });

  it('a dispose error after a failed case keeps the case error and reports both; after a passing case it fails the case', async () => {
    const r = rules({
      A01: [defineCase({ name: 'A01 fails', facet: 'A01/core', needs: [], run: async () => assert.fail('the case error') }), defineCase({ name: 'A01 passes', facet: 'A01/core', needs: [], run: ok })],
    });
    const f: HarnessFactory = () => ({
      dispose: async () => {
        throw new Error('the dispose error');
      },
    });
    const { ran } = await collect((bdd) => runBehaviourIn(r, ['A01'], f, { bdd }));
    assert.strictEqual(ran[0].status, 'failed');
    const caseError = ran[0].error as assert.AssertionError & { cleanupErrors?: unknown[] };
    assert.ok(caseError instanceof assert.AssertionError, 'the assertion error itself, so mocha shows its diff');
    assert.strictEqual(caseError.message, 'the case error');
    assert.deepStrictEqual(
      caseError.cleanupErrors?.map((e) => (e as Error).message),
      ['the dispose error'],
    );
    assert.strictEqual(ran[1].status, 'failed');
    assert.match((ran[1].error as Error).message, /the dispose error/);
  });

  it('timeouts: the case value, the 10 s default, and a run option that raises both', async () => {
    const r = rules({
      A02: [defineCase({ name: 'A02 long', facet: 'A02/local', needs: [], timeoutMs: 600_000, run: ok }), defineCase({ name: 'A02 short', facet: 'A02/core', needs: [], run: ok })],
    });
    const plain = await collect((bdd) => runBehaviourIn(r, ['A02'], factory(), { bdd }));
    assert.deepStrictEqual(
      plain.ran.map((x) => x.timeouts),
      [[600_000 + MOCHA_SLACK_MS], [10_000 + MOCHA_SLACK_MS]],
    );
    const raised = await collect((bdd) => runBehaviourIn(r, ['A02'], factory(), { bdd, timeoutMs: 1_200_000 }));
    assert.deepStrictEqual(
      raised.ran.map((x) => x.timeouts),
      [[1_200_000 + MOCHA_SLACK_MS], [1_200_000 + MOCHA_SLACK_MS]],
    );
  });

  it('a case that hangs past its timeout fails on its own deadline, is disposed and leaves Date real for the next case', async () => {
    let disposed = 0;
    const r = rules({
      A01: [defineCase({ name: 'A01 hangs', facet: 'A01/core', needs: [], timeoutMs: 200, run: () => new Promise<void>(() => undefined) }), defineCase({ name: 'A01 next', facet: 'A01/core', needs: [], run: async (_h, k) => assert.strictEqual(Date.now(), k.clock.now().getTime()) })],
    });
    const f: HarnessFactory = () => ({ dispose: async () => void disposed++ });
    const { ran } = await collect((bdd) => runBehaviourIn(r, ['A01'], f, { bdd }));
    assert.strictEqual(ran[0].status, 'failed');
    assert.match((ran[0].error as Error).message, /A01 hangs exceeded 200 ms/);
    assert.deepStrictEqual(ran[0].timeouts, [200 + MOCHA_SLACK_MS], 'mocha waits longer than the kit deadline');
    assert.strictEqual(ran[1].status, 'passed', String(ran[1].error));
    assert.deepStrictEqual(
      ran.map((x) => x.dateReal),
      [true, true],
    );
    assert.strictEqual(disposed, 2);
  });

  it('a kit clock left installed is uninstalled when the next case starts', async () => {
    let leaked: FakeClock | undefined;
    const r = rules({
      A01: [defineCase({ name: 'A01 first', facet: 'A01/core', needs: [], run: async (_h, k) => void (leaked = k.clock) }), defineCase({ name: 'A01 second', facet: 'A01/core', needs: ['fakeDate'], run: async (_h, k) => assert.strictEqual(Date.now(), k.clock.now().getTime()) })],
    });
    const first = await collect((bdd) => runBehaviourIn(rules({ A01: [r.get('A01')!.cases[0]] }), ['A01'], factory(), { bdd }));
    assert.strictEqual(first.ran[0].status, 'passed');
    leaked!.install();
    assert.notStrictEqual(Date, RealDate);
    const second = await collect((bdd) => runBehaviourIn(rules({ A01: [r.get('A01')!.cases[1]] }), ['A01'], factory(), { bdd }));
    assert.strictEqual(second.ran[0].status, 'passed', String(second.ran[0].error));
    assert.strictEqual(Date, RealDate);
  });

  it('a requested rule without cases registers one visible pending case and a summary line', async () => {
    const { describes, ran, logs } = await collect((bdd) => runBehaviourIn(RULES, ['A03', 'A04'], factory({ events: new RecordingEventSink() }), { bdd }));
    assert.deepStrictEqual(describes, ['authn behaviour', 'A03 rule A03', 'A04 rule A04']);
    assert.deepStrictEqual(
      ran.map((x) => [x.title, x.status]),
      [
        ['A03 store case', 'passed'],
        ['A04 [pending: not transcribed yet (PENDING_TRANSCRIPTION)]', 'pending'],
      ],
    );
    assert.deepStrictEqual(logs, ['authn-testing pending: A04 → not transcribed yet (PENDING_TRANSCRIPTION)']);
    const claimed = await collect((bdd) => runBehaviourIn(RULES, ['A04'], factory(), { bdd, claim: ['A04/local'], facets: ['A04/local'] }));
    assert.deepStrictEqual(
      claimed.ran.map((x) => x.status),
      ['pending'],
      'a claim cannot make an untranscribed rule pass or fail',
    );
    const elsewhere = await collect((bdd) => runBehaviourIn(RULES, ['A03', 'A04'], factory(), { bdd, facets: ['A03/argon2'] }));
    assert.deepStrictEqual(
      elsewhere.ran.map((x) => x.title),
      ['A03 store case [pending: missing events]'],
      'facets of other rules only: nothing registered for it',
    );
  });

  it('config and prepared reach the factory and the case', async () => {
    const seen: unknown[] = [];
    const r = rules({
      A01: [
        defineCase({
          name: 'A01 config',
          facet: 'A01/core',
          needs: [],
          prepare: async () => ({ data: 7 }),
          config: (p) => ({ env: p?.data === 7 ? 'production' : 'test' }),
          run: async (_h, k) => void seen.push(k.config, k.prepared?.data),
        }),
      ],
    });
    const f: HarnessFactory = (ctx) => (seen.push(ctx.rule, ctx.facet, ctx.caseName, ctx.config), {});
    await collect((bdd) => runBehaviourIn(r, ['A01'], f, { bdd }));
    assert.deepStrictEqual(seen, ['A01', 'A01/core', 'A01 config', { env: 'production' }, { env: 'production' }, 7]);
  });

  it('settleCase reports passed, pending and failed outside mocha', async () => {
    const [p] = planCases(['A02'], { facets: ['A02/core'] });
    assert.strictEqual((await settleCase(p, factory())).status, 'pending');
    const failing = await settleCase(p, () => ({ service: {} as never, seed: {} as never, events: new RecordingEventSink() }));
    assert.strictEqual(failing.status, 'failed');
  });

  it('runAuthnBehaviour binds the kit registry', async () => {
    const { ran } = await collect((bdd) => runAuthnBehaviour(['A07'], factory(), { bdd, facets: ['A07/store'] }));
    assert.strictEqual(ran.length, 7);
    assert.ok(ran.every((x) => x.status === 'pending'));
  });
});

describe('steps.send and steps.sendRaw', () => {
  const sent: HttpRequest[] = [];
  const h = {
    http: {
      origin: 'https://app.example.test',
      sessionCookie: 'ssid',
      socketAddress: '127.0.0.1',
      probePath: '/kit/probe',
      routes: {},
      send: async (req: HttpRequest): Promise<HttpResponse> => (sent.push(req), { status: 200, headers: {}, setCookie: [], body: {} }),
    },
  };
  const last = () => sent[sent.length - 1];

  it('send adds the app origin to POST, PUT, PATCH and DELETE without origin or sec-fetch-site', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      await send(h, { method, path: '/x' });
      assert.strictEqual(last().headers?.origin, 'https://app.example.test', method);
    }
  });

  it('send leaves GET, OPTIONS and pre-set headers alone', async () => {
    await send(h, { method: 'GET', path: '/x' });
    assert.strictEqual(last().headers?.origin, undefined);
    await send(h, { method: 'OPTIONS', path: '/x' });
    assert.strictEqual(last().headers?.origin, undefined);
    await send(h, { method: 'POST', path: '/x', headers: { Origin: 'https://evil.example.net' } });
    assert.deepStrictEqual(last().headers, { Origin: 'https://evil.example.net' });
    await send(h, { method: 'POST', path: '/x', headers: { 'sec-fetch-site': 'same-origin' } });
    assert.deepStrictEqual(last().headers, { 'sec-fetch-site': 'same-origin' });
  });

  it('sendRaw adds nothing', async () => {
    await sendRaw(h, { method: 'POST', path: '/x' });
    assert.strictEqual(last().headers, undefined);
  });

  it('send keeps cookies in the jar', async () => {
    const jarred = { http: { ...h.http, send: async (req: HttpRequest): Promise<HttpResponse> => (sent.push(req), { status: 200, headers: {}, setCookie: ['ssid=v1; Path=/'], body: {} }) } };
    const { CookieJar } = await import('../src/helpers/index.js');
    const jar = new CookieJar();
    await send(jarred, { method: 'GET', path: '/a' }, jar);
    await send(jarred, { method: 'GET', path: '/b' }, jar);
    assert.deepStrictEqual(last().cookies, { ssid: 'v1' });
  });
});

describe('conformance withSubject', () => {
  it('a body that hangs past the deadline fails, disposes and leaves Date real', async () => {
    let disposed = 0;
    await assert.rejects(
      withSubject(
        () => ({ dispose: async () => void disposed++ }),
        true,
        () => new Promise<void>(() => undefined),
        { timeoutMs: 100, name: 'hanging case' },
      ),
      /hanging case exceeded 100 ms/,
    );
    assert.strictEqual(disposed, 1);
    assert.strictEqual(Date, RealDate);
  });

  it('a skip followed by a dispose error fails with the dispose error alone', async () => {
    const t: TestThis = {
      test: { title: 'skipped case' },
      timeout: () => undefined,
      skip: () => {
        throw SKIP;
      },
    };
    const err = await withSubject(
      () => ({
        dispose: async () => {
          throw new Error('dispose broke');
        },
      }),
      true,
      async () => pending(t, 'n/a'),
    ).then(
      () => assert.fail('expected a rejection'),
      (e: unknown) => e as Error,
    );
    assert.match(err.message, /dispose broke/);
    assert.ok(!err.message.includes('Symbol(skip)'), err.message);
  });

  it('a body error stays the error; a dispose error rides along', async () => {
    const err = await withSubject(
      () => ({
        dispose: async () => {
          throw new Error('dispose broke');
        },
      }),
      true,
      async () => assert.fail('body broke'),
    ).then(
      () => assert.fail('expected a rejection'),
      (e: unknown) => e as Error & { cleanupErrors?: Error[] },
    );
    assert.strictEqual(err.message, 'body broke');
    assert.deepStrictEqual(
      err.cleanupErrors?.map((e) => e.message),
      ['dispose broke'],
    );
  });
});
