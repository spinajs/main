/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { bootUow, registerUowConnection, UowOrder, UowOrderItem, UowOrderTag, UowTag } from './uowFixture.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

describe('static Model.populate', function () {
  this.timeout(10000);

  before(() => registerUowConnection());
  beforeEach(async () => {
    await bootUow();
  });
  afterEach(() => DI.clearCache());

  beforeEach(async () => {
    await UowOrder.insert({ Total: 10 });
    await UowOrder.insert({ Total: 20 });
    await UowTag.insert({ Name: 'red' });
    await UowTag.insert({ Name: 'blue' });
    await UowTag.insert({ Name: 'green' });
    await UowOrderTag.insert({ order_id: 1, tag_id: 1 });
    await UowOrderTag.insert({ order_id: 1, tag_id: 2 });
    await UowOrderTag.insert({ order_id: 2, tag_id: 3 });
    await UowOrderItem.insert({ Sku: 'A', Qty: 1, order_id: 1 });
  });

  it('returns the linked target rows for a manyToMany relation', async () => {
    const result = await (UowOrder as any).populate('Tags', 1);

    expect(result).to.not.equal(undefined);
    expect(result.map((t: any) => t.Name).sort()).to.deep.equal(['blue', 'red']);
  });

  it('scopes a manyToMany populate to the given owner', async () => {
    const result = await (UowOrder as any).populate('Tags', 2);

    expect(result.map((t: any) => t.Name)).to.deep.equal(['green']);
  });

  it('accepts a model instance as the owner', async () => {
    const order = await UowOrder.where({ Id: 1 }).first();
    const result = await (UowOrder as any).populate('Tags', order);

    expect(result).to.have.length(2);
  });

  it('returns hydrated target models, not junction rows', async () => {
    const result = await (UowOrder as any).populate('Tags', 1);

    expect(result[0]).to.be.instanceOf(UowTag);
    expect(result[0].Id).to.be.a('number');
  });

  it('returns an empty array for an owner with no links', async () => {
    await UowOrder.insert({ Total: 30 });
    const result = await (UowOrder as any).populate('Tags', 3);

    expect(result).to.deep.equal([]);
  });

  it('still works for hasMany', async () => {
    const result = await (UowOrder as any).populate('Items', 1);

    expect(result.map((i: any) => i.Sku)).to.deep.equal(['A']);
  });

  it('throws for an unknown relation', () => {
    expect(() => (UowOrder as any).populate('Nope', 1)).to.throw(/relation/i);
  });
});
