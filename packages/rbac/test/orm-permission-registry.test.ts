import { expect } from 'chai';
import { Class, DI } from '@spinajs/di';
import { Connection, IWhereBuilder, Model, ModelBase, Primary } from '@spinajs/orm';
import { OrmResource } from '../src/decorators.js';
import {
  OrmPermission,
  OrmPermissionPolicy,
  clearOrmPermissionRegistry,
  policyMapKey,
  ormPermissionModel,
  ORM_PERMISSION_POLICY_MAP,
  DEFAULT_PERMISSION_SCOPE,
} from '../src/orm-permission.js';
import type { User } from '../src/models/User.js';

@Connection('default')
@Model('test')
@OrmResource('RegistryModel')
class RegistryModel extends ModelBase {
  @Primary()
  public Id: number;
}

/** Same resource name — must share RegistryModel's policies (the EntriesGroupView shape). */
@Connection('default')
@Model('test')
@OrmResource('RegistryModel')
class RegistryViewModel extends RegistryModel {}

/** Structurally UNRELATED to RegistryModel, but shares its resource string on purpose
 * (the CampaignFileAttachment / ArrowV1CampaignView shape) — must register alongside it,
 * not overwrite it. */
@Connection('default')
@Model('test')
@OrmResource('RegistryModel')
class UnrelatedSharedResourceModel extends ModelBase {
  @Primary()
  public Id: number;
}

/** No @OrmResource — registration must be refused. */
@Connection('default')
@Model('test')
class UnresourcedModel extends ModelBase {
  @Primary()
  public Id: number;
}

function registeredClasses(resource: string, scope: string): Class<OrmPermissionPolicy>[] | undefined {
  return DI.get<Map<string, Class<OrmPermissionPolicy>[]>>(ORM_PERMISSION_POLICY_MAP)?.get(policyMapKey(resource, scope));
}

describe('OrmPermissionPolicy registration', () => {
  beforeEach(() => clearOrmPermissionRegistry());

  it('registers the default-scope policy under <resource>:default in the DI map as a single-entry list', () => {
    @OrmPermission(RegistryModel)
    class P extends OrmPermissionPolicy<RegistryModel> {
      public scope(_q: IWhereBuilder<RegistryModel>, _u: User): void {}
    }
    expect(registeredClasses('RegistryModel', DEFAULT_PERMISSION_SCOPE)).to.eql([P]);
    expect(DI.resolve(P)).to.be.instanceOf(P);
  });

  it('registers a named scope independently of default', () => {
    @OrmPermission(RegistryModel)
    class Def extends OrmPermissionPolicy<RegistryModel> {
      public scope(): void {}
    }
    @OrmPermission(RegistryModel, 'pool')
    class Pool extends OrmPermissionPolicy<RegistryModel> {
      public scope(): void {}
    }
    expect(registeredClasses('RegistryModel', DEFAULT_PERMISSION_SCOPE)).to.eql([Def]);
    expect(registeredClasses('RegistryModel', 'pool')).to.eql([Pool]);
  });

  it('records the bound model on the policy class', () => {
    @OrmPermission(RegistryModel)
    class P extends OrmPermissionPolicy<RegistryModel> {
      public scope(): void {}
    }
    expect(ormPermissionModel(P)).to.equal(RegistryModel);
  });

  it('a model sharing a resource name resolves the same policy (view over base table)', () => {
    @OrmPermission(RegistryModel)
    class P extends OrmPermissionPolicy<RegistryModel> {
      public scope(): void {}
    }
    // RegistryViewModel declares @OrmResource('RegistryModel') — identical key
    @OrmPermission(RegistryViewModel, 'extra')
    class ViewOnly extends OrmPermissionPolicy<RegistryViewModel> {
      public scope(): void {}
    }
    expect(registeredClasses('RegistryModel', DEFAULT_PERMISSION_SCOPE)).to.eql([P]);
    expect(registeredClasses('RegistryModel', 'extra')).to.eql([ViewOnly]);
  });

  it('two structurally unrelated models sharing one resource+scope both register — no overwrite', () => {
    @OrmPermission(RegistryModel)
    class P extends OrmPermissionPolicy<RegistryModel> {
      public scope(): void {}
    }
    @OrmPermission(UnrelatedSharedResourceModel)
    class Q extends OrmPermissionPolicy<UnrelatedSharedResourceModel> {
      public scope(): void {}
    }
    const list = registeredClasses('RegistryModel', DEFAULT_PERMISSION_SCOPE);
    expect(list).to.have.members([P, Q]);
    expect(list).to.have.length(2);
    expect(ormPermissionModel(P)).to.equal(RegistryModel);
    expect(ormPermissionModel(Q)).to.equal(UnrelatedSharedResourceModel);
  });

  it('unknown resource/scope yields undefined from the map', () => {
    expect(registeredClasses('Nope', DEFAULT_PERMISSION_SCOPE)).to.equal(undefined);
    expect(registeredClasses('RegistryModel', 'nope')).to.equal(undefined);
  });

  it('throws on duplicate registration for the same model+scope', () => {
    @OrmPermission(RegistryModel)
    class P1 extends OrmPermissionPolicy<RegistryModel> {
      public scope(): void {}
    }
    expect(() => {
      @OrmPermission(RegistryModel)
      class P2 extends OrmPermissionPolicy<RegistryModel> {
        public scope(): void {}
      }
      void P2;
    }).to.throw(/duplicate/i);
    void P1;
  });

  it('does NOT throw when a different model shares the resource+scope of an already-registered policy', () => {
    @OrmPermission(RegistryModel)
    class P1 extends OrmPermissionPolicy<RegistryModel> {
      public scope(): void {}
    }
    expect(() => {
      @OrmPermission(UnrelatedSharedResourceModel)
      class P2 extends OrmPermissionPolicy<UnrelatedSharedResourceModel> {
        public scope(): void {}
      }
      void P2;
    }).to.not.throw();
    void P1;
  });

  it('throws when the model carries no @OrmResource', () => {
    expect(() => {
      @OrmPermission(UnresourcedModel)
      class P extends OrmPermissionPolicy<UnresourcedModel> {
        public scope(): void {}
      }
      void P;
    }).to.throw(/OrmResource/);
  });

  it('base class defaults: scopeRead/Update/Delete delegate to scope(), scope() and authorizeCreate() throw', async () => {
    const calls: string[] = [];
    class P extends OrmPermissionPolicy<RegistryModel> {
      public scope(): void {
        calls.push('scope');
      }
    }
    const p = new P();
    p.scopeRead(undefined as never, undefined as never);
    p.scopeUpdate(undefined as never, undefined as never);
    p.scopeDelete(undefined as never, undefined as never);
    expect(calls).to.eql(['scope', 'scope', 'scope']);

    class Empty extends OrmPermissionPolicy<RegistryModel> {}
    expect(() => new Empty().scope(undefined as never, undefined as never)).to.throw(/scope/);
    let createErr: unknown;
    await new Empty().authorizeCreate(undefined as never, undefined as never).catch((e) => (createErr = e));
    // OrmException.toString() is deliberately blanked (packages/orm/src/exceptions.ts) to avoid
    // leaking driver credentials through implicit stringification, so assert on .message rather
    // than String(err) -- same assertion strength, just through the accessor that actually works.
    expect((createErr as Error).message).to.match(/authorizeCreate/);
  });
});
