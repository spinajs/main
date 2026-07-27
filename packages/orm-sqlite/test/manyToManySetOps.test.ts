/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { DI } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';
import { bootUow, registerUowConnection, rows, UowOrder, UowOrderTag, UowTag } from './uowFixture.js';

describe('ManyToManyRelationList set operations', function () {
  this.timeout(10000);

  before(() => registerUowConnection());
  beforeEach(async () => {
    await bootUow();
  });
  afterEach(() => DI.clearCache());

  async function seeded() {
    await UowOrder.insert({ Total: 10 });
    await UowTag.insert({ Name: 'red' }); // 1
    await UowTag.insert({ Name: 'blue' }); // 2
    await UowTag.insert({ Name: 'green' }); // 3
    await UowOrderTag.insert({ order_id: 1, tag_id: 1 });
    await UowOrderTag.insert({ order_id: 1, tag_id: 2 });
    return await UowOrder.where({ Id: 1 }).populate('Tags').first();
  }

  it('intersection returns the members present in both sets, by primary key', async () => {
    const order = await seeded();
    const other = await UowTag.find([2, 3]);

    const result = order.Tags.intersection(other as any);

    expect(result.map((t: any) => t.Id)).to.deep.equal([2]);
  });

  it('intersection honours a custom comparator', async () => {
    const order = await seeded();
    const other = [new UowTag({ Name: 'blue' })];

    const result = order.Tags.intersection(other as any, (a: any, b: any) => a.Name === b.Name);

    expect(result.map((t: any) => t.Name)).to.deep.equal(['blue']);
  });

  it('diff returns the symmetric difference by primary key', async () => {
    const order = await seeded();
    const other = await UowTag.find([2, 3]);

    const result = order.Tags.diff(other as any);

    expect(result.map((t: any) => t.Id).sort()).to.deep.equal([1, 3]);
  });

  it('diff honours a custom comparator', async () => {
    const order = await seeded();
    const other = [new UowTag({ Name: 'blue' }), new UowTag({ Name: 'green' })];

    const result = order.Tags.diff(other as any, (a: any, b: any) => a.Name === b.Name);

    expect(result.map((t: any) => t.Name).sort()).to.deep.equal(['green', 'red']);
  });

  it('union appends without removing anything', async () => {
    const order = await seeded();
    const green = await UowTag.where({ Id: 3 }).first();

    order.Tags.union([green] as any);

    expect(order.Tags.length).to.equal(3);
    expect(order.Tags.map((t: any) => t.Id).sort()).to.deep.equal([1, 2, 3]);
  });

  it('does not touch the database on its own', async () => {
    const order = await seeded();
    const green = await UowTag.where({ Id: 3 }).first();

    order.Tags.union([green] as any);

    expect(await rows('uow_order_tag')).to.have.length(2);
  });

  it('composes with set() the way Dataset is meant to be used', async () => {
    const order = await seeded();
    const other = await UowTag.find([2, 3]);

    order.Tags.set(order.Tags.intersection(other as any) as any);

    expect(order.Tags.map((t: any) => t.Id)).to.deep.equal([2]);
  });

  it('feeds the unit-of-work diff', async () => {
    const order = await seeded();
    const other = await UowTag.find([2, 3]);

    order.Tags.set(order.Tags.intersection(other as any) as any);
    const result = await order.save();

    expect(result.JunctionDeleted).to.equal(1);
    const links = await rows('uow_order_tag');
    expect(links.map((l: any) => l.tag_id)).to.deep.equal([2]);
  });
});
