import { expect } from 'chai';
import { Class, DI } from '@spinajs/di';
import { Connection, IWhereBuilder, Model, ModelBase, Primary } from '@spinajs/orm';
import { OrmResource } from '../src/decorators.js';
import {
  OrmPermission,
  OrmPermissionPolicy,
  clearOrmPermissionRegistry,
  policyMapKey,
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

/** No @OrmResource — registration must be refused. */
@Connection('default')
@Model('test')
class UnresourcedModel extends ModelBase {
  @Primary()
  public Id: number;
}

function registeredClass(resource: string, scope: string): Class<OrmPermissionPolicy> | undefined {
  return DI.get<Map<string, Class<OrmPermissionPolicy>>>(ORM_PERMISSION_POLICY_MAP)?.get(policyMapKey(resource, scope));
}

describe('OrmPermissionPolicy registration', () => {
  beforeEach(() => clearOrmPermissionRegistry());

  it('registers the default-scope policy under <resource>:default in the DI map', () => {
    @OrmPermission(RegistryModel)
    class P extends OrmPermissionPolicy<RegistryModel> {
      public scope(_q: IWhereBuilder<RegistryModel>, _u: User): void {}
    }
    expect(registeredClass('RegistryModel', DEFAULT_PERMISSION_SCOPE)).to.equal(P);
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
    expect(registeredClass('RegistryModel', DEFAULT_PERMISSION_SCOPE)).to.equal(Def);
    expect(registeredClass('RegistryModel', 'pool')).to.equal(Pool);
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
    expect(registeredClass('RegistryModel', DEFAULT_PERMISSION_SCOPE)).to.equal(P);
    expect(registeredClass('RegistryModel', 'extra')).to.equal(ViewOnly);
  });

  it('unknown resource/scope yields undefined from the map', () => {
    expect(registeredClass('Nope', DEFAULT_PERMISSION_SCOPE)).to.equal(undefined);
    expect(registeredClass('RegistryModel', 'nope')).to.equal(undefined);
  });

  it('throws on duplicate registration for the same resource+scope', () => {
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
