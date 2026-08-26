import { expect } from 'chai';
import 'mocha';
import { BelongsTo, Connection, HasMany, Primary } from '../src/decorators.js';
import { ModelBase } from '../src/model.js';
import { extractModelDescriptor } from '../src/descriptor.js';
import { SingleRelation } from '../src/relation-objects.js';
import { pkGeneration, generateClientSideKeys, assertAssignedKeys } from '../src/primary-keys.js';
import { DI } from '@spinajs/di';
import { Orm } from '../src/orm.js';

@Connection('sqlite')
class SinglePkModel extends ModelBase {
  @Primary()
  public Id: number;
}

@Connection('sqlite')
class CompositePkModel extends ModelBase {
  @Primary()
  public TenantId: number;

  @Primary()
  public Code: string;
}

@Connection('sqlite')
class DerivedPkModel extends SinglePkModel {
  public Extra: string;
}

/**
 * Two levels of derivation, which is what actually exercises the de-duplication.
 *
 * `extractModelDescriptorInherited` reduces over the whole constructor chain and merges with a
 * custom `_.assignWith` merger whose first branch CONCATENATES arrays. At one level of
 * derivation the base contributes `['Id']` exactly once, so nothing duplicates. At two levels
 * the intermediate class's *own* cached descriptor already contains the inherited `['Id']`, so
 * the reduce sees `['Id']` from the base AND `['Id']` from the intermediate and concatenates
 * them into `['Id','Id']`.
 */
@Connection('sqlite')
class DerivedTwicePkModel extends DerivedPkModel {
  public Extra2: string;
}

@Connection('sqlite')
class NoPkModel extends ModelBase {
  public Name: string;
}

describe('IModelDescriptor.PrimaryKey', () => {
  it('is a one-element array for a single @Primary() column', () => {
    expect(extractModelDescriptor(SinglePkModel)!.PrimaryKey).to.deep.equal(['Id']);
  });

  it('records every @Primary() column in declaration order', () => {
    expect(extractModelDescriptor(CompositePkModel)!.PrimaryKey).to.deep.equal(['TenantId', 'Code']);
  });

  it('does not duplicate an inherited primary key', () => {
    expect(extractModelDescriptor(DerivedPkModel)!.PrimaryKey).to.deep.equal(['Id']);
  });

  it('does not duplicate a primary key inherited through two levels', () => {
    expect(extractModelDescriptor(DerivedTwicePkModel)!.PrimaryKey).to.deep.equal(['Id']);
  });

  it('is an empty array when the model has no primary key', () => {
    expect(extractModelDescriptor(NoPkModel)!.PrimaryKey).to.deep.equal([]);
  });
});

/**
 * A relation's PrimaryKey / ForeignKey each name exactly ONE column ( the JOIN compiler emits a
 * one-column ON predicate ), so a composite primary key has no defensible default. Refusing to
 * guess is the point: silently taking PrimaryKey[0] joins on half the key and returns
 * cross-product rows.
 *
 * NOTE: no @Model here. @Model registers the class into the global DI '__models__' bag, which
 * inflates the unrelated 'Load models from dirs' count assertion in model.test.ts. @Connection
 * and @Primary alone are enough to build the descriptor these tests read.
 */
describe('@Primary generation strategies', () => {
  @Connection('sqlite')
  class GenAutoKeyModel extends ModelBase {
    @Primary()
    public Id: number;
  }

  @Connection('sqlite')
  class GenUuidKeyModel extends ModelBase {
    @Primary({ generated: 'uuid' })
    public Id: string;
  }

  @Connection('sqlite')
  class GenAssignedKeyModel extends ModelBase {
    @Primary({ generated: 'assigned' })
    public Code: string;
  }

  it('defaults to auto', () => {
    expect(pkGeneration(extractModelDescriptor(GenAutoKeyModel)!, 'Id')).to.equal('auto');
  });

  it('records uuid', () => {
    expect(pkGeneration(extractModelDescriptor(GenUuidKeyModel)!, 'Id')).to.equal('uuid');
  });

  it('records assigned', () => {
    expect(pkGeneration(extractModelDescriptor(GenAssignedKeyModel)!, 'Code')).to.equal('assigned');
  });

  it('generateClientSideKeys fills an unset uuid key with a canonical v4 uuid', () => {
    const target: any = {};
    generateClientSideKeys(target, extractModelDescriptor(GenUuidKeyModel)!);

    expect(target.Id).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('generateClientSideKeys never overwrites a supplied uuid key', () => {
    const target: any = { Id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
    generateClientSideKeys(target, extractModelDescriptor(GenUuidKeyModel)!);

    expect(target.Id).to.equal('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });

  it('generateClientSideKeys leaves auto keys alone', () => {
    const target: any = {};
    generateClientSideKeys(target, extractModelDescriptor(GenAutoKeyModel)!);

    expect(target.Id).to.be.undefined;
  });

  it('assertAssignedKeys throws when an assigned key is missing', () => {
    expect(() => assertAssignedKeys({}, extractModelDescriptor(GenAssignedKeyModel)!)).to.throw(/must be assigned/);
  });

  it('assertAssignedKeys passes when an assigned key is supplied', () => {
    expect(() => assertAssignedKeys({ Code: 'x' }, extractModelDescriptor(GenAssignedKeyModel)!)).to.not.throw();
  });
});

describe('relation defaults against composite keys', () => {
  it('rejects a @HasMany whose source model has a composite key and no explicit primaryKey', () => {
    expect(() => {
      @Connection('sqlite')
      class CompositeParent extends ModelBase {
        @Primary() public TenantId: number;
        @Primary() public Code: string;

        @HasMany(SinglePkModel)
        public Children: any;
      }
      return CompositeParent;
    }).to.throw(/composite primary key/);
  });

  it('accepts a @HasMany on a composite-key model when primaryKey is named', () => {
    expect(() => {
      @Connection('sqlite')
      class CompositeParentOk extends ModelBase {
        @Primary() public TenantId: number;
        @Primary() public Code: string;

        @HasMany(SinglePkModel, { primaryKey: 'TenantId', foreignKey: 'tenant_id' })
        public Children: any;
      }
      return CompositeParentOk;
    }).to.not.throw();
  });

  it('rejects a @BelongsTo whose target model has a composite key and no explicit primaryKey', () => {
    expect(() => {
      @Connection('sqlite')
      class BelongsChild extends ModelBase {
        @Primary() public Id: number;

        @BelongsTo(CompositePkModel)
        public Parent: SingleRelation<any>;
      }
      return BelongsChild;
    }).to.throw(/composite primary key/);
  });
});

/**
 * A string-target relation reads its target's key lazily, and the seed phase of a migration run
 * is the one moment where the lazy read happens while `Orm` itself is still resolving - the
 * container has no instance to hand back yet, so a getter that goes through `DI.get(Orm)` reads
 * `Models` off undefined and throws. `Orm.wireRelations()` has already run by then, so the wired
 * `TargetModel` is the source of truth that IS available.
 */
describe('string-target relation PrimaryKey without a resolved Orm', () => {
  @Connection('sqlite')
  class LazyKeyTarget extends ModelBase {
    @Primary()
    public Id: number;
  }

  @Connection('sqlite')
  class LazyKeySource extends ModelBase {
    @Primary()
    public Id: number;

    @BelongsTo('LazyKeyTarget')
    public Target: SingleRelation<any>;
  }

  @Connection('sqlite')
  class UnwiredKeySource extends ModelBase {
    @Primary()
    public Id: number;

    @BelongsTo('NeverRegisteredTarget')
    public Target: SingleRelation<any>;
  }

  beforeEach(() => {
    DI.uncache(Orm);
  });

  it('reads the wired TargetModel when the container has no Orm instance', () => {
    const relation = extractModelDescriptor(LazyKeySource)!.Relations.get('Target')!;
    relation.TargetModel = LazyKeyTarget as any;

    expect(relation.PrimaryKey).to.equal('Id');
  });

  it('falls back to the source model key instead of throwing when the target cannot be resolved at all', () => {
    const relation = extractModelDescriptor(UnwiredKeySource)!.Relations.get('Target')!;

    expect(() => relation.PrimaryKey).to.not.throw();
    expect(relation.PrimaryKey).to.equal('Id');
  });
});
