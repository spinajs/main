import * as chai from 'chai';
import 'mocha';

import { Authorizer } from '../../../src/engine/authorizer.js';
import type { AuthorizerOptions } from '../../../src/engine/authorizer.js';
import { FieldCombiner } from '../../../src/engine/fields.js';
import { runAsync } from '../../../src/engine/run.js';
import { AuthzConfigError, FALSE, SYSTEM, ScopeAttributeStore, TRUE, and, compileFieldGlobs, filterObject } from '../../../src/index.js';
import type { CheckInput, Decision, DecisionRequest, FieldSet, Principal, ResourceFilter, ResourceRef, Vote } from '../../../src/index.js';
import { RecordingLog, StaticModel, deny, permit, principal, registryOf } from '../fakes.js';

const expect = chai.expect;

const vote = (model: string, permitWhen: ResourceFilter, denyWhen: ResourceFilter, fields?: FieldSet): Vote => Object.freeze({ model, permitWhen, denyWhen, cacheable: true, ...(fields ? { fields } : {}) });
const owner: ResourceFilter = Object.freeze({ op: 'relation', relation: 'owner' });
const serviceOnly: ResourceFilter = Object.freeze({ op: 'cmp', field: 'kind', cmp: 'eq', value: 'internal' });
const allows = (globs: readonly string[], path: string) => compileFieldGlobs(globs).allows(path);

describe('B17: fields (core)', () => {
  const combiner = new FieldCombiner({ neverRead: ['Password'] });

  it('B17: read/write = union over permitting votes', () => {
    const r = combiner.combine('deny-overrides', [vote('rbac', TRUE, FALSE, { read: ['Name', 'Email'], write: ['Name'] }), vote('abac', owner, FALSE, { read: ['Phone'], write: ['Phone'] }), vote('other', FALSE, FALSE, { read: ['Salary'] })]);
    expect(r.read).to.deep.equal(['Email', 'Name', 'Phone']);
    expect(r.write).to.deep.equal(['Name', 'Phone']);
  });

  it('B17: minus hide from denying votes', () => {
    const r = combiner.combine('deny-overrides', [vote('rbac', TRUE, FALSE), vote('abac', FALSE, serviceOnly, { hide: ['Salary'] })]);
    expect(allows(r.read, 'Salary')).to.equal(false);
    expect(allows(r.write, 'Salary')).to.equal(false);
    expect(allows(r.read, 'Name')).to.equal(true);
  });

  it('B17: minus neverRead (default Password) on read; write is untouched', () => {
    const r = combiner.combine('deny-overrides', [vote('rbac', TRUE, FALSE)]);
    expect(allows(r.read, 'Password')).to.equal(false);
    expect(allows(r.read, 'Name')).to.equal(true);
    expect(allows(r.write, 'Password')).to.equal(true);
  });

  it('B17: `!X` negations and `A.*` globs work', () => {
    const r = combiner.combine('deny-overrides', [vote('rbac', TRUE, FALSE, { read: ['*', '!Salary', 'Address.*', '!Address.Private'] })]);
    expect(allows(r.read, 'Name')).to.equal(true);
    expect(allows(r.read, 'Salary')).to.equal(false);
    expect(allows(r.read, 'Address.City')).to.equal(true);
    expect(allows(r.read, 'Address.Private')).to.equal(false);
  });

  it('B17: the output filter keeps only readable fields', () => {
    const r = combiner.combine('deny-overrides', [vote('rbac', TRUE, FALSE, { read: ['*', '!Salary'] })]);
    const user = { Name: 'Ann', Salary: 100, Password: 'hash', Address: { City: 'X' } };
    expect(filterObject(r.read, user)).to.deep.equal({ Name: 'Ann', Address: { City: 'X' } });
  });

  it('B17: a denial reads and writes nothing', () => {
    expect(combiner.combine('deny-overrides', [vote('rbac', FALSE, TRUE, { read: ['*'] })])).to.deep.equal({ read: [], write: [] });
  });
});

describe('B17: fields through the Authorizer', () => {
  const registry = registryOf([{ name: 'doc:read', types: ['doc'] }]);
  const alice = principal('user', 'alice');
  const ref = (r: string) => ({ ref: r });
  const eq = (field: string, value: unknown): ResourceFilter => ({ op: 'cmp', field, cmp: 'eq', value } as ResourceFilter);
  const authorizer = (models: StaticModel[], options: Partial<AuthorizerOptions> = {}) => new Authorizer({ domain: 'root', registry, models, ...options });
  const read = (p: Principal = alice) => ({ principal: p, permission: 'doc:read' });
  const negations = ['*', ...Array.from({ length: 300 }, (_, i) => `!*.f${i}`)];
  const subtrees = Array.from({ length: 300 }, (_, i) => `M${i}.*`);
  const notMember = () => new StaticModel('c', { vote: { reason: { code: 'not_member', priority: 500 } } });
  const D1: ResourceRef = { type: 'doc', id: 'd1' };
  const onRow = (subject: object) => ({ ...read(), resource: D1, subject });
  /** The pipeline's result with the step 10 flag (white-box). */
  const pipelineOf = (a: Authorizer, input: CheckInput): Promise<{ readonly decision: Decision; readonly uncacheable: boolean }> => runAsync((a as any)['pipeline'](input, (a as any)['newRun'](false, undefined)));

  class Store extends ScopeAttributeStore {
    constructor(private readonly load: () => Promise<Readonly<Record<string, unknown>>>) {
      super();
    }

    get(): Promise<Readonly<Record<string, unknown>>> {
      return this.load();
    }

    async version(): Promise<string> {
      return '1';
    }
  }

  it('B17: read/write = union over the permitting models', async () => {
    const d = await authorizer([new StaticModel('rbac', { vote: permit(TRUE, { fields: { read: ['Name', 'Email'], write: ['Name'] } }) }), new StaticModel('abac', { vote: permit(serviceOnly, { fields: { read: ['Phone'], write: ['Phone'] } }) }), new StaticModel('other', { vote: { fields: { read: ['Salary'] } } })]).check(read());
    expect(d.allowed).to.equal(true);
    expect(d.fields).to.deep.equal({ read: ['Email', 'Name', 'Phone'], write: ['Name', 'Phone'] });
  });

  it('B17: a denying model hides its fields; neverRead (default Password) limits reads', async () => {
    const d = await authorizer([new StaticModel('rbac', { vote: permit(TRUE, { fields: { read: ['Name', 'Password', 'Email'] } }) }), new StaticModel('abac', { vote: deny(serviceOnly, { fields: { hide: ['Name'] } }) })]).check(read());
    expect(d.allowed).to.equal(true);
    expect(allows(d.fields.read, 'Name')).to.equal(false);
    expect(allows(d.fields.read, 'Password')).to.equal(false);
    expect(allows(d.fields.read, 'Email')).to.equal(true);
    expect(allows(d.fields.write, 'Name')).to.equal(false);
    expect(allows(d.fields.write, 'Password')).to.equal(true);
  });

  it('B17: config.neverRead replaces the default and limits reads only', async () => {
    const d = await authorizer([new StaticModel('rbac', { vote: permit(TRUE) })], { config: { neverRead: ['Salary', 'Secret.*'] } }).check(read());
    expect(allows(d.fields.read, 'Salary')).to.equal(false);
    expect(allows(d.fields.read, 'Secret.Key')).to.equal(false);
    expect(allows(d.fields.read, 'Password')).to.equal(true);
    expect(allows(d.fields.write, 'Salary')).to.equal(true);
  });

  it('B17: SYSTEM reads * minus neverRead and writes *; a denial reads and writes nothing', async () => {
    const a = authorizer([new StaticModel('rbac', { vote: { permitWhen: TRUE, denyWhen: TRUE, fields: { read: ['*'], write: ['*'] } } })]);
    expect((await a.check(read(SYSTEM))).fields).to.deep.equal({ read: ['*', '!Password'], write: ['*'] });
    const d = await a.check(read());
    expect(d.allowed).to.equal(false);
    expect(d.fields).to.deep.equal({ read: [], write: [] });
  });

  it('B17: explain and check give the same fields under permit-overrides', async () => {
    const a = authorizer([new StaticModel('a', { vote: permit(TRUE, { fields: { read: ['Name'] } }) }), new StaticModel('b', { vote: permit(TRUE, { fields: { read: ['*'] } }) })], { combine: { default: { algorithm: 'permit-overrides' } } });
    const checked = await a.check(read());
    const explained = await a.explain(read());
    expect(explained.trace!.votes).to.have.length(2);
    expect(checked.fields.read).to.deep.equal(['Name']);
    expect(explained.fields).to.deep.equal(checked.fields);
  });

  it('B17: explain and check give the same fields under first-applicable', async () => {
    const a = authorizer([new StaticModel('a', { vote: permit(TRUE, { fields: { read: ['*'] } }) }), new StaticModel('b', { vote: deny(TRUE, { fields: { hide: ['Name'] } }) })], { combine: { default: { algorithm: 'first-applicable' } } });
    const checked = await a.check(read());
    const explained = await a.explain(read());
    expect(explained.trace!.votes).to.have.length(2);
    expect(checked.fields.read).to.deep.equal(['*', '!Password']);
    expect(explained.fields).to.deep.equal(checked.fields);
  });

  it('B17: a vote whose permit binds to FALSE adds no fields (missing principal ref)', async () => {
    const tenant = eq('tenantId', ref('principal.attributes.tenantId'));
    const d = await authorizer([new StaticModel('rbac', { vote: permit(TRUE, { fields: { read: ['Name'] } }) }), new StaticModel('abac', { vote: permit(tenant, { fields: { read: ['*'] } }) })]).check(read());
    expect(d.allowed).to.equal(true);
    expect(d.fields.read).to.deep.equal(['Name']);
    expect(allows(d.fields.read, 'Salary')).to.equal(false);
  });

  it('B17: a bound permit that is not FALSE still adds its fields', async () => {
    const tenant = eq('tenantId', ref('principal.attributes.tenantId'));
    const d = await authorizer([new StaticModel('rbac', { vote: permit(TRUE, { fields: { read: ['Name'] } }) }), new StaticModel('abac', { vote: permit(tenant, { fields: { read: ['Salary'] } }) })]).check(read(principal('user', 'alice', { attributes: { tenantId: 't1' } })));
    expect(d.fields.read).to.deep.equal(['Name', 'Salary']);
  });

  it('B17: a scope ref the allow simplified away is still loaded and bound for the fields', async () => {
    const schemas = [{ scopeType: '$global', schema: {}, defaults: { region: 'eu' } }];
    const d = await authorizer([new StaticModel('rbac', { vote: permit(TRUE, { fields: { read: ['Name'] } }) }), new StaticModel('abac', { vote: permit(eq('region', ref('scope.$global.region')), { fields: { read: ['Salary'] } }) })], { scopeAttributes: { schemas } }).check(read());
    expect(d.residual).to.deep.equal(TRUE);
    expect(d.fields.read).to.deep.equal(['Name', 'Salary']);
  });

  it('B17: a ref missing in a deny vote keeps its hide', async () => {
    const internalInRegion = and(serviceOnly, eq('region', ref('principal.attributes.region')));
    const d = await authorizer([new StaticModel('rbac', { vote: permit(TRUE) }), new StaticModel('abac', { vote: deny(internalInRegion, { fields: { hide: ['Salary'] } }) })]).check(read());
    expect(d.allowed).to.equal(true);
    expect(allows(d.fields.read, 'Salary')).to.equal(false);
    expect(allows(d.fields.write, 'Salary')).to.equal(false);
    expect(allows(d.fields.read, 'Name')).to.equal(true);
  });

  it('B17: field globs over the work budget deny with model_error (no model), logged', async () => {
    const log = new RecordingLog();
    const d = await authorizer([new StaticModel('a', { vote: permit(TRUE, { fields: { read: negations } }) }), new StaticModel('b', { vote: permit(TRUE, { fields: { read: subtrees } }) })], { log }).check(read());
    expect(d.allowed).to.equal(false);
    expect(d.reason).to.deep.equal({ code: 'model_error' });
    expect(d.residual).to.deep.equal(FALSE);
    expect(d.fields).to.deep.equal({ read: [], write: [] });
    expect(log.at('error').some((e) => /field/i.test(e.message))).to.equal(true);
  });

  it('B17: intersect delegation narrows the fields to both sides', async () => {
    const bob = principal('user', 'bob');
    const token = principal('token', 't1', { onBehalfOf: bob });
    const byPrincipal = (req: DecisionRequest): Vote => ({ model: 'm', permitWhen: TRUE, denyWhen: FALSE, cacheable: true, fields: req.principal.id === 'bob' ? { read: ['Name', 'Phone'], write: ['*'] } : { read: ['Name', 'Email'], write: ['Name'] } });
    const d = await authorizer([new StaticModel('m', { vote: byPrincipal })]).check(read(token));
    expect(d.allowed).to.equal(true);
    expect(d.fields).to.deep.equal({ read: ['Name'], write: ['Name'] });
  });

  it("B17: a fields budget failure reports exactly model_error, not a non-permitting vote's reason", async () => {
    const control = await authorizer([new StaticModel('a', { vote: permit(TRUE) }), notMember()]).check(read());
    expect(control.allowed).to.equal(true);
    const d = await authorizer([new StaticModel('a', { vote: permit(TRUE, { fields: { read: negations } }) }), new StaticModel('b', { vote: permit(TRUE, { fields: { read: subtrees } }) }), notMember()]).check(read());
    expect(d.allowed).to.equal(false);
    expect(d.reason).to.deep.equal({ code: 'model_error' });
    expect(d.fields).to.deep.equal({ read: [], write: [] });
  });

  it('B17: with a subject, the fields are combined only when the subject step allows', async () => {
    const owner = new StaticModel('own', { vote: permit(eq('ownerId', 'alice'), { fields: { read: ['Name'], write: ['Name'] } }) });
    const allowed = await authorizer([owner]).check(onRow({ ownerId: 'alice' }));
    expect(allowed.residual).to.deep.equal(TRUE);
    expect(allowed.fields).to.deep.equal({ read: ['Name'], write: ['Name'] });

    // These field lists blow the budget once combined: a subject denial never gets that far.
    const blowUp = () => [new StaticModel('a', { vote: permit(eq('ownerId', 'alice'), { fields: { read: negations } }) }), new StaticModel('b', { vote: permit(eq('ownerId', 'alice'), { fields: { read: subtrees } }) }), notMember()];
    const denied = await authorizer(blowUp()).check(onRow({ ownerId: 'carol' }));
    expect(denied.allowed).to.equal(false);
    expect(denied.reason!.code).to.not.equal('model_error');
    expect(denied.fields).to.deep.equal({ read: [], write: [] });

    // Allowed by the subject, then the budget fails: the engine fault is the only cause.
    const failed = await authorizer(blowUp()).check(onRow({ ownerId: 'alice' }));
    expect(failed.allowed).to.equal(false);
    expect(failed.reason).to.deep.equal({ code: 'model_error' });
    expect(failed.fields).to.deep.equal({ read: [], write: [] });
  });

  it("B17: a budget failure in the intersect with the delegate's fields denies with model_error", async () => {
    const own = { read: negations, write: ['*'] };
    const theirs = { read: subtrees, write: ['*'] };
    // Each side combines alone; only their intersection is over the budget.
    const combiner = new FieldCombiner({ neverRead: ['Password'] });
    const [a, b] = [own, theirs].map((fields) => combiner.combine('deny-overrides', [vote('m', TRUE, FALSE, fields)]));
    expect(() => combiner.intersect(a, b)).to.throw(AuthzConfigError);

    const log = new RecordingLog();
    const token = principal('token', 't1', { onBehalfOf: principal('user', 'bob') });
    const byPrincipal = (req: DecisionRequest): Vote => ({ model: 'm', permitWhen: TRUE, denyWhen: FALSE, cacheable: true, fields: req.principal.id === 'bob' ? theirs : own });
    const d = await authorizer([new StaticModel('m', { vote: byPrincipal }), notMember()], { log }).check(read(token));
    expect(d.allowed).to.equal(false);
    expect(d.reason).to.deep.equal({ code: 'model_error' });
    expect(d.residual).to.deep.equal(FALSE);
    expect(d.fields).to.deep.equal({ read: [], write: [] });
    expect(log.at('error').some((e) => /field/i.test(e.message))).to.equal(true);
  });

  it('B17: under inherit the fields come from the votes of the delegate the models ran as', async () => {
    const agent = principal('agent', 'a1', { onBehalfOf: principal('user', 'bob'), delegation: 'inherit' });
    const byPrincipal = (req: DecisionRequest): Vote => ({ model: 'm', permitWhen: TRUE, denyWhen: FALSE, cacheable: true, fields: req.principal.id === 'bob' ? { read: ['Name', 'Phone'], write: ['Name'] } : { read: ['*'], write: ['*'] } });
    const d = await authorizer([new StaticModel('m', { vote: byPrincipal })]).check(read(agent));
    expect(d.allowed).to.equal(true);
    expect(d.principal).to.include({ type: 'user', id: 'bob' });
    expect(d.fields).to.deep.equal({ read: ['Name', 'Phone'], write: ['Name'] });
  });

  describe('B17: a failed load in the fields cover', () => {
    const schemas = [{ scopeType: '$global', schema: {}, defaults: { region: 'eu' } }];
    // The allow is or(TRUE, P2) = TRUE: only the fields cover loads the node P2 reads.
    const models = () => [new StaticModel('rbac', { vote: permit(TRUE, { fields: { read: ['Name'] } }) }), new StaticModel('abac', { vote: permit(eq('region', ref('scope.$global.region')), { fields: { read: ['Salary'] } }) })];
    const withStore = (load: () => Promise<Readonly<Record<string, unknown>>>, log = new RecordingLog()) => authorizer(models(), { scopeAttributes: { schemas, store: new Store(load) }, log, config: { modelTimeoutMs: 50 } });

    it('B17: a healthy load adds the fields and stays cacheable', async () => {
      const r = await pipelineOf(
        withStore(() => Promise.resolve({})),
        read(),
      );
      expect(r.decision.fields.read).to.deep.equal(['Name', 'Salary']);
      expect(r.uncacheable).to.equal(false);
    });

    it("B17: a rejected load drops that vote's fields and makes the decision non-cacheable", async () => {
      const log = new RecordingLog();
      const r = await pipelineOf(
        withStore(() => Promise.reject(new Error('store down')), log),
        read(),
      );
      expect(r.decision.allowed).to.equal(true);
      expect(r.decision.fields.read).to.deep.equal(['Name']);
      expect(r.uncacheable).to.equal(true);
      expect(log.at('error').some((e) => /store down/.test(e.message))).to.equal(true);
    });

    it("B17: a timed-out load drops that vote's fields and makes the decision non-cacheable", async () => {
      const r = await pipelineOf(
        withStore(() => new Promise(() => undefined)),
        read(),
      );
      expect(r.decision.allowed).to.equal(true);
      expect(r.decision.fields.read).to.deep.equal(['Name']);
      expect(r.uncacheable).to.equal(true);
    });

    it('B17: a cover that throws fails closed for the fields, logged and non-cacheable', async () => {
      const log = new RecordingLog();
      const a = withStore(() => Promise.resolve({}), log);
      // The second cover of the check is the fields cover (the first binds the allow).
      const make = (a as any)['refBinder'].bind(a);
      (a as any)['refBinder'] = (...args: unknown[]) => {
        const binder = make(...args);
        const cover = binder.cover.bind(binder);
        let calls = 0;
        binder.cover = function* (filters: readonly ResourceFilter[]) {
          if (++calls === 2) throw new Error('cover down');
          return yield* cover(filters);
        };
        return binder;
      };
      const r = await pipelineOf(a, read());
      expect(r.decision.allowed).to.equal(true);
      expect(r.decision.fields.read).to.deep.equal(['Name']);
      expect(r.uncacheable).to.equal(true);
      expect(log.at('error').some((e) => /cover down/.test(e.message))).to.equal(true);
    });
  });
});
