import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';
import { ModelBase } from '@spinajs/orm';

import { AccessResource, OrmScope, OrmScopePolicy } from '../../src/index.js';
import { classesOf, entryOf, isRegistered, scopePolicyOf, scopeRelationsOf, unregisterResource } from '../../src/registry.js';

const expect = chai.expect;

const TYPE = 'RegistryModel';

// Ported from users legacy-v2/orm-permission-registry.test.ts (B21, B15, B02, B05): registration of
// `@OrmScope` policies, asserted through the registry API (the 2.x DI map and its keys are gone).
describe('OrmScopePolicy registration', () => {
  const made: Function[] = [];
  const track = <T extends Function>(c: T): T => {
    made.push(c);
    return c;
  };

  afterEach(() => {
    for (const c of made.splice(0)) unregisterResource(c);
  });

  // Policy registrations live as long as their class, so every case gets its own classes.
  let RegistryModel: typeof ModelBase;
  /** Same type: shares RegistryModel's policies (the EntriesGroupView shape). */
  let RegistryViewModel: typeof ModelBase;
  /** Structurally UNRELATED to RegistryModel, but shares its type on purpose (the CampaignFileAttachment / ArrowV1CampaignView shape). */
  let UnrelatedSharedTypeModel: typeof ModelBase;
  let UnresourcedModel: typeof ModelBase;

  beforeEach(() => {
    RegistryModel = track(class extends ModelBase {});
    RegistryViewModel = track(class extends (RegistryModel as typeof ModelBase) {});
    UnrelatedSharedTypeModel = track(class extends ModelBase {});
    UnresourcedModel = track(class extends ModelBase {});
    for (const c of [RegistryModel, RegistryViewModel, UnrelatedSharedTypeModel]) AccessResource(TYPE)(c);
  });

  const policy = (): typeof OrmScopePolicy => {
    class P extends OrmScopePolicy {
      scope(): void {}
    }
    return P as never;
  };

  it('registers the default-relation policy under its model and relation', () => {
    const P = policy();
    OrmScope(RegistryModel, 'owner')(P);

    expect(scopePolicyOf(RegistryModel, 'owner')).to.equal(P);
    expect(scopeRelationsOf(RegistryModel)).to.eql(['owner']);
    expect(new (P as never as new () => OrmScopePolicy)()).to.be.instanceOf(P);
  });

  it('registers a named relation independently of the default one', () => {
    const Def = policy();
    const Pool = policy();
    OrmScope(RegistryModel, 'owner')(Def);
    OrmScope(RegistryModel, 'pool')(Pool);

    expect(scopePolicyOf(RegistryModel, 'owner')).to.equal(Def);
    expect(scopePolicyOf(RegistryModel, 'pool')).to.equal(Pool);
    expect(scopeRelationsOf(RegistryModel)).to.have.members(['owner', 'pool']);
  });

  it('records the bound model: a policy is found for its model only', () => {
    const P = policy();
    OrmScope(RegistryModel, 'owner')(P);

    expect(scopePolicyOf(RegistryModel, 'owner')).to.equal(P);
    expect(scopePolicyOf(UnrelatedSharedTypeModel, 'owner')).to.equal(undefined);
  });

  it('a model sharing a type resolves the same policy (view over base table)', () => {
    const P = policy();
    const ViewOnly = policy();
    OrmScope(RegistryModel, 'owner')(P);
    OrmScope(RegistryViewModel, 'extra')(ViewOnly);

    expect(entryOf(RegistryViewModel)?.type).to.equal(TYPE);
    expect(scopePolicyOf(RegistryViewModel, 'owner')).to.equal(P);
    expect(scopePolicyOf(RegistryViewModel, 'extra')).to.equal(ViewOnly);
    expect(scopePolicyOf(RegistryModel, 'extra')).to.equal(undefined);
  });

  it('two structurally unrelated models sharing one type and relation both register, no overwrite', () => {
    const P = policy();
    const Q = policy();
    OrmScope(RegistryModel, 'owner')(P);
    OrmScope(UnrelatedSharedTypeModel, 'owner')(Q);

    expect(classesOf(TYPE)).to.include.members([RegistryModel, UnrelatedSharedTypeModel]);
    expect(scopePolicyOf(RegistryModel, 'owner')).to.equal(P);
    expect(scopePolicyOf(UnrelatedSharedTypeModel, 'owner')).to.equal(Q);
  });

  it('an unknown type or relation yields nothing', () => {
    OrmScope(RegistryModel, 'owner')(policy());

    expect(classesOf('Nope')).to.eql([]);
    expect(scopePolicyOf(RegistryModel, 'nope')).to.equal(undefined);
    expect(scopeRelationsOf(UnresourcedModel)).to.eql([]);
    expect(entryOf(UnresourcedModel)).to.equal(undefined);
  });

  it('throws on a duplicate registration for the same model and relation', () => {
    const P1 = policy();
    OrmScope(RegistryModel, 'owner')(P1);

    expect(() => OrmScope(RegistryModel, 'owner')(policy())).to.throw(AuthzConfigError, /already the policy of that relation/);
    // The same policy again is idempotent (a module loaded twice).
    expect(() => OrmScope(RegistryModel, 'owner')(P1)).to.not.throw();
    expect(scopePolicyOf(RegistryModel, 'owner')).to.equal(P1);
  });

  it('a conflicting second @AccessResource of one class is refused too', () => {
    // B05: a type registered with other options is a boot-time config error, not a silent overwrite.
    expect(() => AccessResource('Other')(RegistryModel)).to.throw(AuthzConfigError, /already registered as resource/);
  });

  it('does NOT throw when a different model shares the type and relation of an already-registered policy', () => {
    OrmScope(RegistryModel, 'owner')(policy());

    expect(() => OrmScope(UnrelatedSharedTypeModel, 'owner')(policy())).to.not.throw();
  });

  it('a model carrying no @AccessResource is never checked, so its policy never applies', () => {
    OrmScope(UnresourcedModel, 'owner')(policy());

    // Changed expectation (B21): 2.x refused the registration; in 3.0 a model without @AccessResource is never
    // checked, so the policy is recorded and has no effect (nothing resolves the model's type).
    expect(isRegistered(UnresourcedModel)).to.equal(false);
    expect(entryOf(UnresourcedModel)).to.equal(undefined);
  });

  it('base class defaults: scope() receives the operation; authorizeCreate, authorizeUpdate and holds are absent', () => {
    const ops: string[] = [];
    class P extends OrmScopePolicy {
      scope(_q: never, _p: never, op: string): void {
        ops.push(op);
      }
    }
    const p = new P();
    p.scope(undefined as never, undefined as never, 'read');
    p.scope(undefined as never, undefined as never, 'update');
    p.scope(undefined as never, undefined as never, 'delete');

    // Changed expectation (B15, B20): one scope(query, principal, op) replaces scopeRead/Update/Delete, so there
    // is nothing to delegate; a policy without authorizeCreate has no create hook, and an insert through its
    // relation is refused (see orm-permission-policy.test.ts).
    expect(ops).to.eql(['read', 'update', 'delete']);
    expect(p.authorizeCreate).to.equal(undefined);
    expect(p.authorizeUpdate).to.equal(undefined);
    expect(p.holds).to.equal(undefined);
    expect(OrmScopePolicy.prototype).to.not.have.property('scope');
  });
});
