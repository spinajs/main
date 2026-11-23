import { expect } from 'chai';
import 'mocha';
import { ModelBase, OrmException } from '../src/index.js';

class Unaudited extends ModelBase {}

describe('Model.audit()', () => {
  it('needs @spinajs/audit-orm', () => {
    const message = 'Model.audit() needs @spinajs/audit-orm: import it so its ModelAuditSource registers';
    expect(() => Unaudited.audit()).to.throw(OrmException, message);
    expect(() => ModelBase.prototype.audit.call(Object.create(ModelBase.prototype) as ModelBase)).to.throw(OrmException, message);
  });
});
