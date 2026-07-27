/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from 'chai';
import 'mocha';
import { IModelDescriptor, IRelationDescriptor, OrphanPolicy, RelationType } from '../src/interfaces.js';
import { resolveOrphanPolicy } from '../src/orphan.js';
import { _prepareColumnDesc } from '../src/decorators.js';

function relation(over: Partial<IRelationDescriptor> = {}): IRelationDescriptor {
  return {
    Name: 'Items',
    Type: RelationType.Many,
    TargetModelType: 'Item',
    TargetModel: undefined as any,
    SourceModel: null,
    ForeignKey: 'owner_id',
    PrimaryKey: 'Id',
    Recursive: false,
    ...over,
  } as IRelationDescriptor;
}

function target(nullable: boolean, reflected: boolean, softDelete?: string): IModelDescriptor {
  return {
    PrimaryKey: ['Id'],
    PrimaryKeyGeneration: new Map(),
    Connection: 'sqlite',
    TableName: 'item',
    Timestamps: {} as any,
    SoftDelete: (softDelete ? { DeletedAt: softDelete } : {}) as any,
    Archived: {} as any,
    Columns: [_prepareColumnDesc({ Name: 'owner_id', Nullable: nullable, NativeType: reflected ? 'INT' : '' })],
    Converters: new Map(),
    JunctionModelProperties: [],
    Relations: new Map(),
    Name: 'Item',
    DiscriminationMap: {} as any,
    Driver: null,
    Schema: null,
  } as unknown as IModelDescriptor;
}

describe('resolveOrphanPolicy', () => {
  it('defaults to nullify when the foreign key is nullable', () => {
    expect(resolveOrphanPolicy(relation(), target(true, true))).to.equal(OrphanPolicy.Nullify);
  });

  it('falls back to delete when the foreign key is reflected and not nullable', () => {
    expect(resolveOrphanPolicy(relation(), target(false, true))).to.equal(OrphanPolicy.Delete);
  });

  it('keeps nullify when the foreign key column is not reflected', () => {
    expect(resolveOrphanPolicy(relation(), target(false, false))).to.equal(OrphanPolicy.Nullify);
  });

  it('keeps nullify when the target descriptor does not list the foreign key at all', () => {
    const t = target(false, true);
    t.Columns = [];
    expect(resolveOrphanPolicy(relation(), t)).to.equal(OrphanPolicy.Nullify);
  });

  it('honours an explicit delete even when the foreign key is nullable', () => {
    expect(resolveOrphanPolicy(relation({ Orphan: OrphanPolicy.Delete }), target(true, true))).to.equal(OrphanPolicy.Delete);
  });

  it('honours an explicit nullify even when the foreign key is not nullable', () => {
    expect(resolveOrphanPolicy(relation({ Orphan: OrphanPolicy.Nullify }), target(false, true))).to.equal(OrphanPolicy.Nullify);
  });

  it('honours disable', () => {
    expect(resolveOrphanPolicy(relation({ Orphan: OrphanPolicy.Disable }), target(false, true))).to.equal(OrphanPolicy.Disable);
  });

  it('honours soft-delete when the target carries @SoftDelete', () => {
    expect(resolveOrphanPolicy(relation({ Orphan: OrphanPolicy.SoftDelete }), target(true, true, 'DeletedAt'))).to.equal(OrphanPolicy.SoftDelete);
  });

  it('throws for soft-delete when the target has no DeletedAt column', () => {
    expect(() => resolveOrphanPolicy(relation({ Orphan: OrphanPolicy.SoftDelete }), target(true, true))).to.throw(/soft-delete/);
  });
});
