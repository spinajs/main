import 'mocha';
import { expect } from 'chai';
import { AuthzConfigError, DecisionAudit, DecisionReplay, ReplayBusy, ReplayInTransaction } from '@spinajs/authz';
import type { DecisionRequest, ReplayOptions, ReplayReport } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { RecordingAudit, testHost } from '@spinajs/authz-testing';
import type { ScriptedVote } from '@spinajs/authz-testing';

import { DecisionsControllerSource, DecisionsPolicy } from '../src/index.js';

import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { createDomain } from './support/domain.js';
import type { TestDomain } from './support/domain.js';
import { registerHeaderSource } from './support/principals.js';

const D = 'dec';
const OTHER = 'dec-other';
// Declares no authz:replay: a check of it there throws UnknownPermission.
const BARE = 'dec-bare';
const ID = '019a8e2c-6c1e-7a51-9f3e-2b1c4d5e6f70';
const URL = `/authz/decisions/${ID}/explain`;
const ENABLED = { 'authz.http.decisionsRoute': { enabled: true, permission: 'authz:replay' } };

// bob and frank hold authz:replay in D only, erin in both domains, carol only on a condition; dave holds authz:explain.
const holders: Record<string, readonly string[]> = { [D]: ['bob', 'erin', 'frank'], [OTHER]: ['erin'] };
const votes =
  (domain: string) =>
  (req: DecisionRequest): ScriptedVote => {
    if (req.permission === 'authz:explain') return req.principal.id === 'dave' ? { permitWhen: { op: 'true' } } : {};
    if (req.permission !== 'authz:replay') return {};
    if (req.principal.id === 'carol') return { permitWhen: { op: 'cmp', field: 'x', cmp: 'eq', value: 1 } };
    return (holders[domain] ?? []).includes(req.principal.id) ? { permitWhen: { op: 'true' } } : {};
  };

const report = (over: Partial<ReplayReport> = {}, domain = D): ReplayReport => ({
  decision: { id: ID, at: '2026-11-17T10:00:00.000Z', domain, principal: 'user:alice', permission: 'file:read', resource: { type: 'file', id: 'f1' }, allowed: false, cached: false, policyHash: 'unknown', modelVersions: {}, inputsHash: 'h' },
  currentPolicy: false,
  replay: 'faithful',
  evidence: 'outcome',
  outcome: { recorded: 'deny', replayed: 'deny' },
  inputsHash: { recorded: 'h', replayed: null },
  missing: [],
  divergence: [],
  tree: { label: 'file:f1#file:read', truth: 'deny', source: 'union', children: [] },
  reads: [],
  limits: { changes: 0, maxChanges: 50000, keys: 0, durationMs: 1 },
  ...over,
});

const calls: Array<{ id: string; options?: ReplayOptions }> = [];
let answer: () => Promise<ReplayReport | undefined> = async () => report();

class StubReplay extends DecisionReplay {
  public async replay(id: string, options?: ReplayOptions): Promise<ReplayReport | undefined> {
    calls.push({ id, options });
    return answer();
  }
}

const registerReplay = () => DI.register(StubReplay).as(DecisionReplay);
const unregisterReplay = () => {
  DI.unregister(StubReplay);
  DI.uncache(StubReplay);
  DI.uncache(DecisionReplay);
};

async function boot(config: Record<string, unknown>): Promise<{ app: TestApp; domains: TestDomain[] }> {
  const app = await startApp({ config: { 'authz.http.access': { domain: D }, ...config } });
  const permissions = { 'file:read': {}, 'authz:explain': {}, 'authz:replay': {} };
  const domains = [
    await createDomain(D, { permissions, model: { votes: votes(D) } }),
    await createDomain(OTHER, { permissions, model: { votes: votes(OTHER) } }),
    await createDomain(BARE, { permissions: { 'file:read': {} }, model: { votes: votes(BARE) } }),
  ];
  return { app, domains };
}

describe('GET /authz/decisions/:id/explain', function () {
  this.timeout(30000);

  let unregisterSource: () => void;
  let running: { app: TestApp; domains: TestDomain[] } | undefined;
  const get = (path: string, user?: string) => {
    const req = running!.app.request().get(path);
    return user === undefined ? req : req.set('x-user', user);
  };

  before(() => {
    unregisterSource = registerHeaderSource();
    registerReplay();
  });

  beforeEach(() => {
    calls.length = 0;
    answer = async () => report();
  });

  const shutdown = async () => {
    for (const d of running?.domains ?? []) await d.dispose();
    running = undefined;
    await stopApp();
    // test/support/app.js, which the loader picks over app.ts, predates this policy: its stopApp does not uncache it.
    DI.uncache(DecisionsPolicy);
  };

  afterEach(shutdown);

  after(() => {
    unregisterReplay();
    unregisterSource();
  });

  it('is not registered while disabled (404)', async () => {
    running = await boot({});
    expect((await get(URL, 'bob')).status).to.eq(404);
    expect(calls).to.have.length(0);
  });

  it('answers the report with each verdict', async () => {
    running = await boot(ENABLED);
    for (const replay of ['faithful', 'divergent', 'unreplayable'] as const) {
      answer = async () => report({ replay });
      const res = await get(URL, 'bob');
      expect(res.status, replay).to.eq(200);
      expect(res.body).to.deep.include({ replay, currentPolicy: false });
      expect((res.body as ReplayReport).decision.id).to.eq(ID);
    }
    expect(calls.map((c) => c.id)).to.deep.eq([ID, ID, ID]);
  });

  it('format=tree answers the replayed tree; another format is a 400', async () => {
    running = await boot(ENABLED);
    const res = await get(`${URL}?format=tree`, 'bob');
    expect(res.status).to.eq(200);
    expect(res.body).to.deep.eq({ label: 'file:f1#file:read', truth: 'deny', source: 'union', children: [] });
    expect((await get(`${URL}?format=xml`, 'bob')).status).to.eq(400);

    const empty = await get(`${URL}?format=`, 'bob');
    expect(empty.status, 'format= is the report').to.eq(200);
    expect((empty.body as ReplayReport).replay).to.eq('faithful');

    answer = async () => report({ replay: 'unreplayable', tree: null });
    const none = await get(`${URL}?format=tree`, 'bob');
    expect(none.status, 'a report without a tree (an unreadable record)').to.eq(200);
    expect(none.text, 'http sends no body for a null answer').to.eq('');
  });

  it('refuses an anonymous caller (401) and one without authz:replay (403), whatever authz:explain grants', async () => {
    running = await boot(ENABLED);
    expect((await get(URL)).status).to.eq(401);
    expect((await get(URL, 'alice')).status).to.eq(403);
    expect((await get(URL, 'dave')).status, 'authz:explain alone').to.eq(403);
    expect((await get(URL, 'carol')).status, 'a conditional grant').to.eq(403);
    expect(calls).to.have.length(0);
  });

  it('answers 404 for an unknown id, and for a record of a domain where the caller lacks authz:replay', async () => {
    running = await boot(ENABLED);
    answer = async () => undefined;
    const unknown = await get(URL, 'bob');
    expect(unknown.status).to.eq(404);

    answer = async () => report({}, OTHER);
    const hidden = await get(URL, 'bob');
    expect(hidden.status).to.eq(404);
    expect(hidden.body).to.deep.eq(unknown.body);
    expect(running.domains[0].audit.of('deny')).to.deep.eq([{ kind: 'deny', principal: { type: 'user', id: 'bob' }, permission: 'file:read', resource: { type: 'file', id: 'f1' }, reason: `replay ${ID} refused: domain ${OTHER}` }]);
    expect(running.domains[0].audit.of('explain'), 'an unknown id names no record').to.have.length(0);
    expect((await get(URL, 'erin')).status, 'held in both domains').to.eq(200);

    answer = async () => report({}, 'no-such-domain');
    expect((await get(URL, 'erin')).status, 'a domain this node does not run').to.eq(404);

    answer = async () => report({}, BARE);
    const undeclared = await get(URL, 'erin');
    expect(undeclared.status, 'a domain that does not declare authz:replay').to.eq(404);
    expect(undeclared.body).to.deep.eq(unknown.body);

    // Listed by names(), but its service cannot boot: the audit service it names is not registered.
    const BROKEN = 'dec-broken';
    testHost.config().set(['authz', 'domains', BROKEN], { audit: { service: 'Missing' } });
    const broken = (await testHost.domains()).create(BROKEN, 'root');
    try {
      answer = async () => report({}, BROKEN);
      const unbootable = await get(URL, 'erin');
      expect(unbootable.status, 'a domain whose service fails to boot').to.eq(404);
      expect(unbootable.body).to.deep.eq(unknown.body);
    } finally {
      await broken.dispose();
      testHost.config().unset(['authz', 'domains', BROKEN]);
    }
  });

  it('refuses an id that is not a UUID with 400, before any replay', async () => {
    running = await boot(ENABLED);
    expect((await get('/authz/decisions/not-a-uuid/explain', 'bob')).status).to.eq(400);
    expect(calls).to.have.length(0);
  });

  it('answers 429 with Retry-After: 5 while the replays of the process are busy', async () => {
    running = await boot(ENABLED);
    answer = async () => Promise.reject(new ReplayBusy(2));
    const res = await get(URL, 'bob');
    expect(res.status).to.eq(429);
    expect(res.get('Retry-After')).to.eq('5');
    expect(res.body).to.deep.include({ error: 'replay_busy' });
  });

  it("writes one explain audit entry per answered call, naming the replayed decision, to the domain's selected audit", async () => {
    running = await boot(ENABLED);
    // Registered after the boot picked the domain's audit: the last registration, but not the selected one.
    const later = new RecordingAudit();
    (await testHost.domains()).container(D).register(testHost.instance(later)).as(DecisionAudit);
    await get(URL, 'bob');
    await get(`${URL}?format=tree`, 'bob');
    const entries = running.domains[0].audit.of('explain');
    expect(entries).to.have.length(2);
    expect(entries[0]).to.deep.include({ kind: 'explain', principal: { type: 'user', id: 'bob' }, permission: 'file:read', resource: { type: 'file', id: 'f1' }, reason: `replay ${ID}` });
    expect(later.entries).to.have.length(0);
  });

  it('DecisionsControllerSource refuses to hand over the route when enabled with no DecisionReplay registered, naming @spinajs/authz-orm/replay', async () => {
    const source = new DecisionsControllerSource();
    Object.defineProperty(source, 'Enabled', { value: true });
    expect(await source.getControllers()).to.have.length(1);

    unregisterReplay();
    try {
      const error: unknown = await source.getControllers().then(() => null, (e: unknown) => e);
      expect(error).to.be.instanceOf(AuthzConfigError);
      expect((error as Error).message).to.contain('@spinajs/authz-orm/replay');
    } finally {
      registerReplay();
    }
  });

  it('authz.http.rateLimit.decisions: { limit: 1 } answers the limiter 429 to the second call; false takes the limit off', async () => {
    running = await boot({ ...ENABLED, 'authz.http.rateLimit.decisions': { limit: 1, windowSeconds: 60, by: 'principal' } });
    expect((await get(URL, 'frank')).status).to.eq(200);
    const refused = await get(URL, 'frank');
    expect(refused.status).to.eq(429);
    expect(refused.body).to.not.have.property('error', 'replay_busy');
    await shutdown();

    running = await boot({ ...ENABLED, 'authz.http.rateLimit.decisions': false });
    for (let i = 0; i < 3; i++) expect((await get(URL, 'frank')).status).to.eq(200);
  });

  it('hands req.storage.signal to the replay while http.deadline is enabled', async () => {
    running = await boot({ ...ENABLED, 'http.deadline': { enabled: true, ms: 30000 } });
    await get(URL, 'bob');
    expect(calls[0].options?.signal).to.be.instanceOf(AbortSignal);
    await shutdown();

    running = await boot(ENABLED);
    calls.length = 0;
    await get(URL, 'bob');
    expect(calls[0].options?.signal).to.eq(undefined);
  });

  it('is registered in production when enabled, where only a replay refused inside a transaction answers 500 with error replay_refused', async () => {
    running = await boot({ ...ENABLED, 'configuration.isProduction': true });
    expect((await get(URL, 'bob')).status).to.eq(200);
    answer = async () => Promise.reject(new ReplayInTransaction());
    const res = await get(URL, 'bob');
    expect(res.status).to.eq(500);
    expect(res.body).to.deep.include({ error: 'replay_refused' });
    expect((res.body as { message: string }).message).to.contain('inside a transaction');

    answer = async () => Promise.reject(new AuthzConfigError('authz replay: two history contributors are registered for the tuple changelog kind'));
    const misconfigured = await get(URL, 'bob');
    expect(misconfigured.status, 'any other configuration error is an ordinary 500').to.eq(500);
    expect(JSON.stringify(misconfigured.body)).to.not.contain('replay_refused').and.not.contain('contributors');
  });
});
