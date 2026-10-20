import * as chai from 'chai';
import 'mocha';

import * as authz from '../../src/index.js';
import { AuthorizationModel, ResourceAdapter, FALSE, GLOBAL, TRUE, UNATTENDED, resourceKey } from '../../src/index.js';
import type { AccessPlan, DecisionRequest, DenyReason, EvaluationContext, ListPlanRequest, ListSupport, ListSupportContext, ModelCapabilities, ModelInitContext, ModelListPlan, PermissionDef, PlanTerm, Principal, ResourceRef, ResourceType, Vote } from '../../src/index.js';

const expect = chai.expect;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const yes = <_T extends true>(): void => {};

const caps: ModelCapabilities = { effects: ['permit'], residuals: ['true', 'false'], sync: 'always', fields: false, needsSubject: false };
const vote = (model: string): Vote => ({ model, permitWhen: TRUE, denyWhen: FALSE, cacheable: true });
const owner: PlanTerm = { op: 'relation.owner', args: { principals: [{ type: 'user', id: 'u1' }] } };
const taskRead: PermissionDef = { name: 'task:read', resource: 'task', action: 'read', types: ['task'], list: true, source: 'config' };
const taskEdit: PermissionDef = { name: 'task:edit', resource: 'task', action: 'edit', types: ['task'], source: 'config' };

class PlainModel extends AuthorizationModel {
  public readonly name = 'plain';
  public readonly capabilities = caps;
  public init(_ctx: ModelInitContext): void {}
  public applies(_p: PermissionDef, _t: ResourceType): boolean {
    return true;
  }
  public evaluate(_req: DecisionRequest, _ctx: EvaluationContext): Vote {
    return vote('plain');
  }
}

class ListingModel extends PlainModel {
  public listSupport(permission: PermissionDef, _type: ResourceType): ListSupport {
    return permission.list === true ? true : { reason: `${permission.name} is not a list permission` };
  }
  public async listPlan(req: ListPlanRequest, _ctx: EvaluationContext): Promise<ModelListPlan> {
    return req.env?.ip === undefined ? { kind: 'terms', permit: [owner], deny: [] } : { kind: 'abstain' };
  }
}

class PlainAdapter extends ResourceAdapter<{ id: string }> {
  public readonly kind = 'plain';
  public readonly types = ['task'];
  public accepts(target: unknown): target is { id: string } {
    return typeof target === 'object' && target !== null && 'id' in target;
  }
  public refOf(target: { id: string }): ResourceRef {
    return { type: 'task', id: target.id };
  }
  public async ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null> {
    return [ref, GLOBAL];
  }
}

class BatchAdapter extends PlainAdapter {
  public async loadMany(refs: readonly ResourceRef[]): Promise<ReadonlyMap<string, unknown>> {
    return new Map(refs.filter((r) => r.id !== 'gone').map((r): [string, unknown] => [resourceKey(r), { id: r.id }]));
  }
  public async ancestorsMany(refs: readonly ResourceRef[]): Promise<ReadonlyMap<string, readonly ResourceRef[] | null>> {
    return new Map(refs.map((r): [string, readonly ResourceRef[] | null] => [resourceKey(r), r.id === 'gone' ? null : [r, GLOBAL]]));
  }
}

describe('list plan contracts', () => {
  it('core holds no SQL contract: an adapter compiles list terms its own way', () => {
    expect((authz as Record<string, unknown>).PlanTermSql).to.equal(undefined);
  });

  it('list members of AuthorizationModel and batch members of ResourceAdapter are optional', () => {
    expect(new PlainModel().listSupport).to.equal(undefined);
    expect(new PlainModel().listPlan).to.equal(undefined);
    expect(new PlainAdapter().loadMany).to.equal(undefined);
    expect(new PlainAdapter().ancestorsMany).to.equal(undefined);
  });

  it('a model answers list support and a list plan', async () => {
    const m = new ListingModel();
    expect(m.listSupport(taskRead, 'task')).to.equal(true);
    expect(m.listSupport(taskEdit, 'task')).to.deep.equal({ reason: 'task:edit is not a list permission' });
    const ctx = undefined as unknown as EvaluationContext;
    const req: ListPlanRequest = { principal: UNATTENDED, permission: taskRead, type: 'task', env: { now: new Date(0) } };
    expect(await m.listPlan(req, ctx)).to.deep.equal({ kind: 'terms', permit: [owner], deny: [] });
    expect(await m.listPlan({ ...req, actor: UNATTENDED, env: { ip: '10.0.0.1' } }, ctx)).to.deep.equal({ kind: 'abstain' });
  });

  it('an adapter loads rows and ancestors by resourceKey', async () => {
    const a = new BatchAdapter();
    const refs: ResourceRef[] = [
      { type: 'task', id: '1' },
      { type: 'task', id: 'gone' },
    ];
    const rows = await a.loadMany(refs);
    expect([...rows.keys()]).to.deep.equal(['task:1']);
    const ancestors = await a.ancestorsMany(refs);
    expect(ancestors.get('task:1')).to.deep.equal([refs[0], GLOBAL]);
    expect(ancestors.get('task:gone')).to.equal(null);
  });

  it('an all plan may carry deny terms', () => {
    const plain: ModelListPlan = { kind: 'all' };
    const withDeny: ModelListPlan = { kind: 'all', deny: [owner], validUntil: new Date(0) };
    expect(plain).to.not.have.property('deny');
    expect(withDeny.kind === 'all' ? withDeny.deny : undefined).to.deep.equal([owner]);
  });

  it('PermissionDef carries list', () => {
    yes<Equal<Pick<PermissionDef, 'list'>, { readonly list?: boolean }>>();
    expect(taskRead.list).to.equal(true);
  });

  it('pins the plan shapes', () => {
    yes<Equal<PlanTerm, { readonly op: string; readonly args: unknown }>>();
    yes<
      Equal<
        ModelListPlan,
        | { readonly kind: 'abstain' }
        | { readonly kind: 'all'; readonly deny?: readonly PlanTerm[]; readonly validUntil?: Date }
        | { readonly kind: 'deny-all'; readonly reason: DenyReason }
        | { readonly kind: 'terms'; readonly permit: readonly PlanTerm[]; readonly deny: readonly PlanTerm[]; readonly validUntil?: Date }
      >
    >();
    yes<
      Equal<
        AccessPlan,
        | { readonly kind: 'none'; readonly reason: DenyReason }
        | { readonly kind: 'filter'; readonly permit: 'all' | readonly PlanTerm[]; readonly deny: readonly PlanTerm[]; readonly within?: readonly ResourceRef[]; readonly validUntil?: Date }
      >
    >();
    yes<Equal<ListSupport, true | { readonly reason: string }>>();
    yes<Equal<ListPlanRequest, { readonly principal: Principal; readonly actor?: Principal; readonly permission: PermissionDef; readonly type: ResourceType; readonly env?: Readonly<Record<string, unknown>>; readonly fresh?: boolean }>>();
    yes<Equal<Pick<AuthorizationModel, 'listSupport' | 'listPlan'>, { listSupport?: (permission: PermissionDef, type: ResourceType, ctx?: ListSupportContext) => ListSupport; listPlan?: (req: ListPlanRequest, ctx: EvaluationContext) => Promise<ModelListPlan> }>>();
    yes<Equal<Pick<ResourceAdapter, 'loadMany' | 'ancestorsMany'>, { loadMany?: (refs: readonly ResourceRef[]) => Promise<ReadonlyMap<string, unknown>>; ancestorsMany?: (refs: readonly ResourceRef[]) => Promise<ReadonlyMap<string, readonly ResourceRef[] | null>> }>>();
    expect(true).to.equal(true);
  });
});
