/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from 'chai';
import 'mocha';
import { IModelDescriptor, IRelationDescriptor, OrphanPolicy, RelationType } from '../src/interfaces.js';
import { resolveOrphanPolicy } from '../src/orphan.js';
import { _prepareColumnDesc } from '../src/decorators.js';
import { SubjectExecutor } from '../src/subject-executor.js';
import { IOrphanDelta } from '../src/subject.js';

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

  it('refuses to guess when the foreign key is reflected and not nullable', () => {
    // Used to silently escalate to DELETE. Removing rows now has to be declared: inferring
    // data destruction from a NOT NULL constraint the developer never pointed at is the one
    // branch that cannot be undone.
    expect(() => resolveOrphanPolicy(relation(), target(false, true))).to.throw(/NOT NULL/);
  });

  it('names the escape hatches when it refuses', () => {
    expect(() => resolveOrphanPolicy(relation(), target(false, true))).to.throw(/OrphanPolicy\.Delete/);
    expect(() => resolveOrphanPolicy(relation(), target(false, true))).to.throw(/OrphanPolicy\.Disable/);
  });

  it('keeps nullify when the foreign key column is not reflected', () => {
    // `_prepareColumnDesc` defaults Nullable to false, so an unreflected model would report
    // every column as NOT NULL and turn every relation into the hard error above.
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

/**
 * `delete` and `destroy()` must mean the same thing for the same model. `ModelBase.destroy()`
 * stamps `DeletedAt` on a `@SoftDelete` model instead of issuing a DELETE; an orphan taking
 * the hard-delete branch made the outcome depend on which code path reached the row.
 */
describe('SubjectExecutor.effectivePolicy', () => {
  class Executor extends SubjectExecutor {
    public policyOf(delta: IOrphanDelta) {
      return this.effectivePolicy(delta);
    }
  }

  function delta(policy: OrphanPolicy, softDelete?: string): IOrphanDelta {
    return {
      Descriptor: relation(),
      TargetDescriptor: target(true, true, softDelete),
      Policy: policy,
      PrimaryKeys: [1],
    };
  }

  const executor = new Executor({});

  it('degrades delete to soft-delete when the target declares @SoftDelete', () => {
    expect(executor.policyOf(delta(OrphanPolicy.Delete, 'DeletedAt'))).to.equal(OrphanPolicy.SoftDelete);
  });

  it('keeps a hard delete when the target has no @SoftDelete column', () => {
    expect(executor.policyOf(delta(OrphanPolicy.Delete))).to.equal(OrphanPolicy.Delete);
  });

  it('leaves nullify and disable alone', () => {
    expect(executor.policyOf(delta(OrphanPolicy.Nullify, 'DeletedAt'))).to.equal(OrphanPolicy.Nullify);
    expect(executor.policyOf(delta(OrphanPolicy.Disable, 'DeletedAt'))).to.equal(OrphanPolicy.Disable);
  });
});
