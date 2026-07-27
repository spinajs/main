/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { DI } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';
import { bootUow, registerUowConnection, rows, UowOrder, UowOrderItem, UowStrictItem } from './uowFixture.js';
import { extractModelDescriptor, OrphanPolicy, RelationType } from '@spinajs/orm';

describe('uow fixtures', function () {
  this.timeout(10000);

  before(() => registerUowConnection());
  beforeEach(async () => {
    await bootUow();
  });
  afterEach(() => DI.clearCache());

  it('creates every uow table', async () => {
    expect(await rows('uow_client')).to.deep.equal([]);
    expect(await rows('uow_order')).to.deep.equal([]);
    expect(await rows('uow_order_item')).to.deep.equal([]);
    expect(await rows('uow_strict_item')).to.deep.equal([]);
    expect(await rows('uow_tag')).to.deep.equal([]);
    expect(await rows('uow_order_tag')).to.deep.equal([]);
    expect(await rows('uow_node')).to.deep.equal([]);
  });

  it('wires UowOrder relations with the declared keys', () => {
    const d = extractModelDescriptor(UowOrder)!;

    expect(d.Relations.get('Client')!.Type).to.equal(RelationType.One);
    expect(d.Relations.get('Client')!.ForeignKey).to.equal('client_id');
    expect(d.Relations.get('Items')!.Type).to.equal(RelationType.Many);
    expect(d.Relations.get('Items')!.ForeignKey).to.equal('order_id');
    expect(d.Relations.get('Items')!.Orphan).to.equal(OrphanPolicy.Delete);
    expect(d.Relations.get('StrictItems')!.Orphan).to.equal(undefined);
    expect(d.Relations.get('Tags')!.Type).to.equal(RelationType.ManyToMany);
    expect(d.Relations.get('Tags')!.JunctionModelSourceModelFKey_Name).to.equal('order_id');
    expect(d.Relations.get('Tags')!.JunctionModelTargetModelFKey_Name).to.equal('tag_id');
  });

  it('reflects uow_order_item.order_id as nullable and uow_strict_item.order_id as not', () => {
    const item = extractModelDescriptor(UowOrderItem)!.Columns.find((c) => c.Name === 'order_id')!;
    const strict = extractModelDescriptor(UowStrictItem)!.Columns.find((c) => c.Name === 'order_id')!;

    expect(item.Nullable).to.equal(true);
    expect(item.NativeType).to.not.equal('');
    expect(strict.Nullable).to.equal(false);
    expect(strict.NativeType).to.not.equal('');
  });
});
