import { expect } from 'chai';
import 'mocha';
import { Connection, ModelBase, Primary, extractModelDescriptor } from '@spinajs/orm';
import { _assertSingleColumnKey } from '../src/interfaces.js';

/**
 * The generic CRUD routes address a row by ONE `:id` path segment. Supporting composite keys
 * over HTTP would mean inventing a key encoding, which is out of scope — so these routes
 * reject composite-key models outright. Silently querying on PrimaryKey[0] would filter on
 * half the key and return the wrong row.
 *
 * NOTE: no @Model here — it registers into the global DI '__models__' bag and would perturb
 * other suites. @Connection + @Primary is enough to build the descriptor.
 */
@Connection('sqlite')
class ApiCompositeModel extends ModelBase {
  @Primary() public TenantId: number;
  @Primary() public Code: string;
}

@Connection('sqlite')
class ApiSingleModel extends ModelBase {
  @Primary() public Id: number;
}

describe('orm-api composite key handling', () => {
  it('rejects a composite-key model on a single-id route', () => {
    expect(() => _assertSingleColumnKey(extractModelDescriptor(ApiCompositeModel)!)).to.throw(/composite primary key/);
  });

  it('returns the key column for a single-key model', () => {
    expect(_assertSingleColumnKey(extractModelDescriptor(ApiSingleModel)!)).to.equal('Id');
  });
});
