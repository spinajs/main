import * as chai from 'chai';
import 'mocha';

import { AsyncService, type IContainer } from '@spinajs/di';
import * as authz from '../../src/index.js';
import { AuthorizationModel, AuthzDomains, AuthzService, ChangeBus, Combinator, ConditionCompiler, ConditionFunction, DecisionAudit, DecisionCache, NativeFilter, RelationResolver, ResourceAdapter, ScopeResolver, FALSE, TRUE, GLOBAL, UNATTENDED } from '../../src/index.js';
import type { AccessSummary, AuthzAdmin, AuthzChange, CheckInput, Condition, Decision, DecisionRequest, EvaluationContext, FieldSet, FilterOp, PermissionRegistry, PrincipalType, TraceStep, ModelCapabilities, ModelInitContext, ModelSummary, Permission, PermissionDef, Principal, PrincipalRef, ResourceFilter, ResourceRef, ResourceType, RoutePlan, Trace, Vote } from '../../src/index.js';

const expect = chai.expect;

const vote = (model: string): Vote => ({ model, permitWhen: TRUE, denyWhen: FALSE, cacheable: true });
const caps: ModelCapabilities = { effects: ['permit'], residuals: ['true', 'false'], sync: 'always', fields: false, needsSubject: false };

class MinimalModel extends AuthorizationModel {
  public readonly name = 'min';
  public readonly capabilities = caps;
  public init(_ctx: ModelInitContext): void {}
  public applies(_p: PermissionDef, _t: ResourceType): boolean {
    return true;
  }
  public evaluate(_req: DecisionRequest, _ctx: EvaluationContext): Vote {
    return vote('min');
  }
}

class FullModel extends AuthorizationModel {
  public readonly name = 'full';
  public readonly capabilities: ModelCapabilities = { ...caps, sync: 'after-preload', principalTypes: ['user'], resourceTypes: '*' };
  public async init(_ctx: ModelInitContext): Promise<void> {}
  public applies(_p: PermissionDef, _t: ResourceType): boolean {
    return false;
  }
  public async evaluate(_req: DecisionRequest, _ctx: EvaluationContext): Promise<Vote> {
    return vote('full');
  }
  public async preload(_p: Principal, _ctx: EvaluationContext): Promise<void> {}
  public async summarize(_p: Principal, _at: ResourceRef, _ctx: EvaluationContext): Promise<ModelSummary> {
    return { model: 'full', permissions: [{ name: 'a:b', conditional: false }] };
  }
  public invalidate(_tags: readonly string[]): void {}
  public version(): string {
    return '1';
  }
  public async dispose(): Promise<void> {}
}

class FakeCombinator extends Combinator {
  public readonly name = 'fake';
  public combine(votes: readonly Vote[]): { allow: ResourceFilter; deciding?: Vote } {
    return { allow: TRUE, deciding: votes[0] };
  }
}

class FakeNative extends NativeFilter {
  public readonly op = 'native:x' as const;
  public matches(_args: unknown, _subject: unknown, _ref: ResourceRef, _ctx: EvaluationContext): boolean {
    return true;
  }
}

class MinimalAdapter extends ResourceAdapter<string> {
  public readonly kind = 'min';
  public readonly types = ['t'];
  public accepts(target: unknown): target is string {
    return typeof target === 'string';
  }
  public refOf(target: string): ResourceRef {
    return { type: 't', id: target };
  }
  public async ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null> {
    return [ref, GLOBAL];
  }
}

class FullAdapter extends MinimalAdapter {
  public readonly compiles = ['cmp' as const];
  public async scopeAttributes(_ref: ResourceRef): Promise<Readonly<Record<string, unknown>> | null> {
    return {};
  }
  public async load(_ref: ResourceRef): Promise<unknown | null> {
    return null;
  }
  public attribute(subject: unknown, field: string): unknown {
    return (subject as Record<string, unknown>)[field];
  }
  public relations(): readonly RelationResolver[] {
    return [];
  }
  public permissions(): readonly Omit<PermissionDef, 'source'>[] {
    return [];
  }
  public operations(): Readonly<Record<string, Permission | readonly Permission[]>> {
    return { read: 't:read' };
  }
}

class FakeScope extends ScopeResolver {
  public readonly types = ['org'];
  public async ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null> {
    return [ref];
  }
  public async attributes(_ref: ResourceRef): Promise<Readonly<Record<string, unknown>> | null> {
    return null;
  }
}

class FakeRelation extends RelationResolver {
  public readonly type = 't';
  public readonly relation = 'owner';
  public holds(_p: Principal, _ref: ResourceRef, _subject?: unknown): boolean {
    return true;
  }
}

const decision: Decision = { allowed: true, permission: 'a:b', resource: GLOBAL, principal: UNATTENDED, residual: TRUE, fields: { read: [], write: [] }, roles: {}, domain: 'root' };
const summary: AccessSummary = { principal: UNATTENDED, models: [], permissions: [] };

class FakeService extends AuthzService {
  public readonly domain = 'root';
  public current(): Principal {
    return UNATTENDED;
  }
  public async runAs<T>(_p: Principal, _reason: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
  public async check(_req: CheckInput): Promise<Decision> {
    return decision;
  }
  public async can(_p: Principal, _permission: Permission, _resource?: ResourceRef | object, _subject?: unknown): Promise<boolean> {
    return true;
  }
  public async assert(_p: Principal, _permission: Permission, _resource?: ResourceRef | object, _subject?: unknown): Promise<Decision> {
    return decision;
  }
  public async checkMany(_p: Principal, permissions: readonly Permission[], _resource?: ResourceRef | object): Promise<ReadonlyMap<Permission, Decision>> {
    return new Map(permissions.map((p) => [p, decision]));
  }
  public async filter(_p: Principal, _permission: Permission, _type: ResourceType): Promise<ResourceFilter> {
    return TRUE;
  }
  public filterNow(_p: Principal, _permission: Permission, _type: ResourceType): ResourceFilter | undefined {
    return undefined;
  }
  public async explain(_req: CheckInput): Promise<Decision> {
    return decision;
  }
  public async summary(_p: Principal, _at?: ResourceRef): Promise<AccessSummary> {
    return summary;
  }
  public async covers(_holder: Principal, _target: Principal, _at?: ResourceRef): Promise<boolean> {
    return true;
  }
  public async preload(_p: Principal): Promise<void> {}
  public invalidate(_tags: readonly string[]): void {}
  public models(): readonly AuthorizationModel[] {
    return [];
  }
  public admin(): AuthzAdmin {
    return undefined as unknown as AuthzAdmin;
  }
}

class FakeDomains extends AuthzDomains {
  public create(_name: string, _parent?: string): IContainer {
    return undefined as unknown as IContainer;
  }
  public container(_name: string): IContainer {
    return undefined as unknown as IContainer;
  }
  public async service(_name: string): Promise<AuthzService> {
    return new FakeService();
  }
  public names(): readonly string[] {
    return ['root'];
  }
}

class FakeCache extends DecisionCache {
  public get(_key: string): Decision | undefined {
    return undefined;
  }
  public set(_key: string, _d: Decision, _tags: readonly string[], _ttlMs: number): void {}
  public invalidate(_tags: readonly string[]): void {}
}

class FakeBus extends ChangeBus {
  public async publish(_change: AuthzChange): Promise<void> {}
  public subscribe(_fn: (c: AuthzChange) => void): () => void {
    return () => {};
  }
}

class FakeAudit extends DecisionAudit {
  public readonly entries: unknown[] = [];
  public record(e: Parameters<DecisionAudit['record']>[0]): void {
    this.entries.push(e);
  }
}

class FakeFunction extends ConditionFunction {
  public readonly name = 'time.between';
  public evaluate(_args: unknown, ctx: { principal: Principal; actor?: Principal; env: Readonly<Record<string, unknown>> }): boolean {
    return ctx.principal === undefined;
  }
}

class FakeCompiler extends ConditionCompiler {
  public async compile(_c: Condition, _req: DecisionRequest, _ctx: EvaluationContext): Promise<{ filter: ResourceFilter; cacheable: boolean; needsSubject: boolean }> {
    return { filter: TRUE, cacheable: true, needsSubject: false };
  }
}

describe('model, adapter, host and condition contracts', () => {
  it('exports every abstract class as a runtime value from the barrel', () => {
    for (const name of ['AuthorizationModel', 'Combinator', 'NativeFilter', 'ResourceAdapter', 'ScopeResolver', 'RelationResolver', 'AuthzService', 'AuthzDomains', 'DecisionCache', 'ChangeBus', 'DecisionAudit', 'ConditionFunction', 'ConditionCompiler', 'PlanTermSql']) {
      expect((authz as Record<string, unknown>)[name], name).to.be.a('function');
    }
  });

  it('exports the host lookup authz() from the package root (F4)', () => {
    expect(authz).to.have.property('authz').that.is.a('function');
  });

  it('models: minimal and full subclasses instantiate', async () => {
    const min = new MinimalModel();
    expect(min).to.be.instanceOf(AuthorizationModel);
    expect(min.preload).to.be.undefined;
    expect(min.dispose).to.be.undefined;
    const full = new FullModel();
    expect(await full.dispose?.()).to.be.undefined;
    expect(full.version?.()).to.eq('1');
    expect((await full.summarize?.(UNATTENDED, GLOBAL, undefined as unknown as EvaluationContext))?.model).to.eq('full');
  });

  it('combinator and native filter instantiate', () => {
    expect(new FakeCombinator().combine([vote('a')]).deciding?.model).to.eq('a');
    expect(new FakeNative().op).to.eq('native:x');
  });

  it('adapters, scope and relation resolvers instantiate', () => {
    const a = new MinimalAdapter();
    expect(a.scopeAttributes).to.be.undefined;
    expect(a.compiles).to.be.undefined;
    expect(a.accepts('x')).to.eq(true);
    const f = new FullAdapter();
    expect(f.attribute({ k: 1 }, 'k')).to.eq(1);
    expect(f.operations()).to.deep.eq({ read: 't:read' });
    expect(new FakeScope().types).to.deep.eq(['org']);
    expect(new FakeRelation().holds(UNATTENDED, GLOBAL)).to.eq(true);
  });

  it('AuthzService is an AsyncService', async () => {
    const s = new FakeService();
    expect(s).to.be.instanceOf(AsyncService);
    expect(s).to.be.instanceOf(AuthzService);
    expect(await s.runAs(UNATTENDED, 'r', async () => 7)).to.eq(7);
    expect((await s.checkMany(UNATTENDED, ['a:b'])).get('a:b')).to.eq(decision);
  });

  it('domains, cache, bus and audit instantiate', () => {
    expect(new FakeDomains().names()).to.deep.eq(['root']);
    expect(new FakeCache().get('k')).to.be.undefined;
    expect(new FakeBus().subscribe(() => {})).to.be.a('function');
    const audit = new FakeAudit();
    const ref: PrincipalRef = { type: 'user', id: '1' };
    const trace: Trace | undefined = undefined;
    audit.record({ kind: 'admin', principal: ref, command: { kind: 'x' }, trace });
    expect(audit.entries).to.have.length(1);
  });

  it('conditions: function and compiler instantiate; literals type-check', async () => {
    const all: Condition = { all: [{ attr: 'principal.id', eq: '1' }, { any: [{ not: { attr: 'env.ip', null: true } }, { fn: 'time.between', args: { from: 1 } }] }] };
    expect(all).to.have.property('all');
    expect(new FakeFunction().evaluate({}, { principal: UNATTENDED, env: {} })).to.eq(false);
    expect((await new FakeCompiler().compile(all, undefined as unknown as DecisionRequest, undefined as unknown as EvaluationContext)).cacheable).to.eq(true);
  });

  it('type-level rejections', () => {
    // @ts-expect-error missing abstract members
    class Broken extends AuthorizationModel {
      public readonly name = 'b';
    }
    expect(Broken).to.be.a('function');

    // @ts-expect-error needsSubject is required
    const noNeeds: ModelCapabilities = { effects: [], residuals: [], sync: 'always', fields: false };
    // @ts-expect-error sync outside the union
    const badSync: ModelCapabilities = { ...caps, sync: 'sometimes' };
    // @ts-expect-error matches no Condition branch
    const badCondition: Condition = { op: 'x' };
    // @ts-expect-error kind outside the union
    new FakeAudit().record({ kind: 'other', principal: UNATTENDED });
    const plan: RoutePlan = { algorithm: 'deny-overrides', models: [] };
    const fields: FieldSet = {};
    expect([noNeeds, badSync, badCondition, plan, fields]).to.have.length(5);
  });

  describe('pinned shapes', () => {
    type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
    const yes = <_T extends true>(): void => {};

    it('accepts full literals of the interfaces', () => {
      const evalCtx: EvaluationContext = {
        domain: 'root',
        now: new Date(0),
        permissions: undefined as unknown as PermissionRegistry,
        ancestors: async (ref) => [ref],
        attributes: async () => null,
        conditions: new FakeCompiler(),
        relation: () => undefined,
        check: async () => decision,
        cache: new Map(),
        trace: () => {},
      };
      const initCtx: ModelInitContext = {
        domain: 'root',
        config: <T>(_path: string, dflt?: T) => dflt as T,
        permissions: undefined as unknown as PermissionRegistry,
        registerPermissions: () => {},
        registerNativeFilter: () => {},
        registerRelation: () => {},
      };
      const minimalChange: AuthzChange = { tags: ['a'], at: new Date(0) };
      const fullChange: AuthzChange = { domain: 'root', tags: [], actor: { type: 'user', id: '1' }, at: new Date(0) };
      const byRef: CheckInput = { principal: UNATTENDED, permission: 'a:b', resource: GLOBAL };
      const byObject: CheckInput = { principal: UNATTENDED, permission: 'a:b', resource: { any: 'object' }, explain: true };
      const noResource: CheckInput = { principal: UNATTENDED, permission: 'a:b' };
      expect([evalCtx, initCtx, minimalChange, fullChange, byRef, byObject, noResource]).to.have.length(7);
    });

    it('pins parameters, optionality, readonly and unions', () => {
      yes<Equal<AuthzService['admin'], () => AuthzAdmin>>();
      yes<Equal<Parameters<RelationResolver['holds']>, [principal: Principal, ref: ResourceRef, subject?: unknown]>>();
      yes<Equal<Parameters<ConditionFunction['evaluate']>, [args: unknown, ctx: { principal: Principal; actor?: Principal; env: Readonly<Record<string, unknown>> }]>>();
      yes<Equal<Parameters<EvaluationContext['trace']>, [step: Omit<TraceStep, 'by'>]>>();
      yes<Equal<Parameters<EvaluationContext['check']>, [req: Omit<DecisionRequest, 'explain'>]>>();
      yes<Equal<NativeFilter['op'], `native:${string}`>>();
      yes<Equal<Parameters<DecisionAudit['record']>[0]['kind'], 'deny' | 'runAs' | 'unscoped' | 'explain' | 'system' | 'admin'>>();
      yes<Equal<CheckInput, Omit<DecisionRequest, 'resource'> & { readonly resource?: ResourceRef | object }>>();
      yes<Equal<Pick<ScopeResolver, 'attributes'>, { attributes?: (ref: ResourceRef) => Promise<Readonly<Record<string, unknown>> | null> }>>();
      yes<Equal<Pick<ResourceAdapter, 'compiles'>, { readonly compiles?: readonly FilterOp[] }>>();
      yes<Equal<AuthzChange, { readonly domain?: string; readonly tags: readonly string[]; readonly actor?: PrincipalRef; readonly at: Date }>>();
      yes<
        Equal<
          ModelCapabilities,
          {
            readonly effects: readonly ('permit' | 'deny')[];
            readonly residuals: readonly FilterOp[];
            readonly sync: 'always' | 'after-preload' | 'never';
            readonly fields: boolean;
            readonly needsSubject: boolean;
            readonly principalTypes?: readonly PrincipalType[];
            readonly resourceTypes?: readonly ResourceType[] | '*';
          }
        >
      >();
      yes<Equal<Pick<EvaluationContext, 'conditions'>, { readonly conditions: ConditionCompiler }>>();
      yes<Equal<keyof ModelInitContext, 'domain' | 'config' | 'permissions' | 'registerPermissions' | 'registerNativeFilter' | 'registerRelation'>>();
      yes<Equal<keyof EvaluationContext, 'domain' | 'now' | 'permissions' | 'ancestors' | 'attributes' | 'conditions' | 'relation' | 'check' | 'cache' | 'trace'>>();
      expect(true).to.eq(true);
    });
  });
});
