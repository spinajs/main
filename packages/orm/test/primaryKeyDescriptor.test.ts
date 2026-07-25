import { expect } from 'chai';
import 'mocha';
import { Connection, Primary } from '../src/decorators.js';
import { ModelBase } from '../src/model.js';
import { extractModelDescriptor } from '../src/descriptor.js';

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
