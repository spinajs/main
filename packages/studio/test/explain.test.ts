import 'mocha';
import { expect } from 'chai';
import { CORE_FILTER_OPS, DecisionAudit, FALSE, NativeFilter, TRUE } from '@spinajs/authz';
import type { Decision, DecisionRequest, DenyReason, ModelInitContext } from '@spinajs/authz';
import { RecordingAudit, StaticModel, testHost } from '@spinajs/authz-testing';
import type { ScriptedVote } from '@spinajs/authz-testing';

import { collectDenies, toStudioDecision } from '../src/authz/explain.js';
import type { StudioCapabilities, StudioExplainResult } from '../src/contracts/index.js';
import { MAX_ATTRIBUTE_BYTES } from '../src/span.js';
import { STUDIO_TEST_PERMISSIONS, startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { registerHeaderSource } from './support/principals.js';

const ASK = { principal: 'user:carol', permission: 'studio:read' };
const LONG = `LONG-${'x'.repeat(5000)}`;
const LONG_NATIVE = `native:${LONG}` as const;

class LongNativeFilter extends NativeFilter {
  public readonly op = LONG_NATIVE;

  public matches(): boolean {
    return false;
  }
}

/** Votes a filter with a model-defined native op of 5000 characters, for mallory only. */
class NativeModel extends StaticModel {
  public constructor() {
    super({
      name: 'm2',
      capabilities: { residuals: [...CORE_FILTER_OPS, LONG_NATIVE] },
      votes: (req) => (req.principal.id === 'mallory' ? { permitWhen: { op: LONG_NATIVE, args: { [LONG]: LONG } } } : {}),
    });
  }

  public init(ctx: ModelInitContext): void {
    super.init(ctx);
    ctx.registerNativeFilter(new LongNativeFilter());
  }
}

/** bob and frank hold everything; dave only authz:explain; erin only the Studio permissions; mallory's vote carries 5000-character strings. */
function explainVotes(req: DecisionRequest): ScriptedVote {
  const holds = (id: string, permissions: readonly string[]) => req.principal.id === id && permissions.includes(req.permission);
  if (holds('bob', STUDIO_TEST_PERMISSIONS) || holds('frank', STUDIO_TEST_PERMISSIONS) || holds('dave', ['authz:explain']) || holds('erin', ['studio:read', 'studio:explain'])) return { permitWhen: TRUE };
  if (req.principal.id === 'mallory') {
    return {
      permitWhen: { op: 'cmp', field: 'owner', cmp: 'eq', value: LONG },
      reason: { code: 'no_access', detail: LONG },
      trace: [{ by: 'm1', step: 'long', note: LONG, data: { [LONG]: [LONG] } }],
    };
  }
  return {};
}

function longestString(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return Math.max(0, ...value.map(longestString));
  if (typeof value === 'object' && value !== null) return Math.max(0, ...Object.entries(value).map(([k, v]) => Math.max(k.length, longestString(v))));
  return 0;
}

describe('POST /_studio/api/authz/explain', function () {
  this.timeout(30000);

  let app: TestApp;
  let unregister: () => void;
  let audit: RecordingAudit;
  const explain = (body: object, user = 'bob') => app.request().post('/_studio/api/authz/explain').set('Accept', 'application/json').set('x-user', user).send(body);

  before(async () => {
    unregister = registerHeaderSource();
    audit = new RecordingAudit();
    testHost.registerInRoot(DecisionAudit, testHost.instance(audit));
    app = await startApp({ votes: explainVotes, models: [new NativeModel()], config: { 'authz.combine.default.models': ['m1', 'm2'] } });
  });

  after(async () => {
    await stopApp();
    unregister();
  });

  it('explains a denied request: the wire decision, the trace once, sorted deny reasons', async () => {
    const res = await explain(ASK);
    expect(res.status).to.eq(200);
    const body = res.body as StudioExplainResult;
    expect(body.decision.allowed).to.eq(false);
    expect(body.decision.principal).to.deep.eq({ type: 'user', id: 'carol' });
    expect(body.decision).to.not.have.property('trace');
    expect(body.trace?.votes.map((v) => v.model)).to.include('m1');
    expect(body.denies.map((d) => d.code)).to.deep.eq(['no_access']);
  });

  it('answers what the engine decides for an allowed principal', async () => {
    const body = (await explain({ ...ASK, principal: 'user:bob' })).body as StudioExplainResult;
    expect(body.decision).to.include({ allowed: true, permission: 'studio:read', domain: 'root' });
    expect(body.denies).to.deep.eq([]);
  });

  it('records one explain audit entry naming the caller and the principal asked about', async () => {
    const byCaller = () => audit.of('explain').filter((e) => e.principal.type === 'user' && e.principal.id === 'bob');
    const before = byCaller().length;
    await explain(ASK);
    const entries = byCaller();
    expect(entries).to.have.length(before + 1);
    const last = entries[entries.length - 1];
    expect(last.permission).to.eq('studio:read');
    expect(last.reason).to.eq('studio explain for user:carol');
  });

  it('cuts every string of the reply at 2 KiB', async () => {
    const res = await explain({ ...ASK, principal: 'user:mallory' });
    expect(res.status).to.eq(200);
    const body = res.body as StudioExplainResult;
    expect(body.trace?.votes[0].trace?.[0].note).to.match(/^LONG-x+…$/);
    expect(body.trace?.votes.find((v) => v.model === 'm2')?.permitWhen.op).to.match(/^native:LONG-x+…$/);
    // A native op keeps its `native:` prefix in front of the cut name.
    expect(longestString(body)).to.be.at.most('native:'.length + MAX_ATTRIBUTE_BYTES + 1);
    expect(res.text).to.not.include(LONG);
  });

  it('answers 400 for a malformed or missing body, without echoing a refused value', async () => {
    const statuses = await Promise.all([
      explain({ principal: 'carol', permission: 'studio:read' }),
      explain({ principal: 'user:carol', permission: 'not a permission' }),
      explain({ ...ASK, extra: true }),
      explain({}),
      explain({ ...ASK, domain: 'zz/qq<' }),
      explain({ ...ASK, domain: 'nope' }),
      explain({ ...ASK, resource: 'r'.repeat(257) }),
    ]);
    expect(statuses.map((r) => r.status)).to.deep.eq([400, 400, 400, 400, 400, 400, 400]);
    expect(statuses[1].text).to.not.include('not a permission');
    expect(statuses[4].text).to.not.include('zz/qq<');
  });

  it('answers 400 for a request without a body', async () => {
    expect((await app.request().post('/_studio/api/authz/explain').set('Accept', 'application/json').set('x-user', 'bob')).status).to.eq(400);
  });

  it('answers 401 without an authenticated caller', async () => {
    expect((await app.request().post('/_studio/api/authz/explain').set('Accept', 'application/json').send(ASK)).status).to.eq(401);
  });

  it('needs both studio:explain and authz:explain', async () => {
    const statuses = await Promise.all(['alice', 'dave', 'erin'].map(async (user) => (await explain(ASK, user)).status));
    expect(statuses).to.deep.eq([403, 403, 403]);
  });

  it('is rate-limited per principal like GET /authz/explain: 30 a minute', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await explain(ASK, 'frank')).status);
    expect(statuses.filter((s) => s === 200)).to.have.length(30);
    expect(statuses[30]).to.eq(429);
  });

  it('is mounted outside production and says so in the capabilities', async () => {
    const res = await app.request().get('/_studio/api/capabilities').set('Accept', 'application/json').set('x-user', 'bob');
    expect((res.body as StudioCapabilities).features.explain).to.eq(true);
  });
});

describe('Studio explain in production', function () {
  this.timeout(30000);

  let unregister: () => void;
  const PRODUCTION = { 'configuration.isProduction': true, 'studio.allowProduction': true };
  const explain = (app: TestApp, user = 'bob') => app.request().post('/_studio/api/authz/explain').set('Accept', 'application/json').set('x-user', user).send(ASK);
  const features = async (app: TestApp) => ((await app.request().get('/_studio/api/capabilities').set('Accept', 'application/json').set('x-user', 'bob')).body as StudioCapabilities).features;

  before(() => {
    unregister = registerHeaderSource();
  });
  after(() => unregister());
  afterEach(() => stopApp());

  it('is not registered without studio.allowExplainInProduction, while the rest of Studio answers', async () => {
    const app = await startApp({ config: PRODUCTION });
    expect((await explain(app)).status).to.eq(404);
    expect((await features(app)).explain).to.eq(false);
  });

  it('is not registered when studio.allowExplainInProduction is not exactly true', async () => {
    const app = await startApp({ config: { ...PRODUCTION, 'studio.allowExplainInProduction': 'true' } });
    expect((await explain(app)).status).to.eq(404);
    expect((await features(app)).explain).to.eq(false);
  });

  it('is registered with studio.allowExplainInProduction, still behind studio:explain and authz:explain', async () => {
    const app = await startApp({ config: { ...PRODUCTION, 'studio.allowExplainInProduction': true } });
    expect((await explain(app)).status).to.eq(200);
    expect((await features(app)).explain).to.eq(true);
    expect((await explain(app, 'alice')).status).to.eq(403);
  });
});

describe('toStudioDecision', () => {
  it('turns validUntil into an ISO string and leaves the trace out', () => {
    const decision: Decision = { allowed: true, permission: 'order:read', resource: { type: 'order' }, principal: { type: 'user', id: 'carol' }, residual: TRUE, fields: { read: [], write: [] }, roles: {}, domain: 'root', validUntil: new Date('2026-11-16T12:00:00.000Z') };
    expect(toStudioDecision(decision)).to.deep.eq({ allowed: true, permission: 'order:read', resource: { type: 'order' }, principal: { type: 'user', id: 'carol' }, residual: TRUE, fields: { read: [], write: [] }, roles: {}, domain: 'root', validUntil: '2026-11-16T12:00:00.000Z' });
  });
});

describe('collectDenies', () => {
  const reason = (code: string, model: string): DenyReason => ({ code, model });

  it('collects vote reasons and deny sources once each, lowest priority first', () => {
    const decision: Decision = {
      allowed: false,
      permission: 'order:read',
      resource: { type: 'order' },
      principal: { type: 'user', id: 'carol' },
      residual: FALSE,
      fields: { read: [], write: [] },
      roles: {},
      domain: 'root',
      reason: reason('no_access', 'rbac'),
      trace: {
        domain: 'root',
        algorithm: 'deny-overrides',
        models: ['rbac', 'abac'],
        steps: [],
        durationMs: 1,
        votes: [
          { model: 'rbac', permitWhen: FALSE, denyWhen: FALSE, cacheable: true, reason: reason('no_access', 'rbac') },
          { model: 'abac', permitWhen: FALSE, denyWhen: TRUE, cacheable: true, denies: [{ when: TRUE, reason: reason('role_denied', 'abac') }] },
        ],
      },
    };
    expect(collectDenies(decision).map((d) => d.code)).to.deep.eq(['role_denied', 'no_access']);
  });
});
