/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from 'chai';
import 'mocha';
import { Subject, SubjectOperation, SubjectSet } from '../src/subject.js';
import { OrmCycleException, SubjectSorter } from '../src/subject-sorter.js';

class Row {
  public PrimaryKeyValue: any;
  constructor(pk?: any) {
    this.PrimaryKeyValue = pk;
  }
}

const desc = (name: string) => ({ Name: name, TableName: name.toLowerCase(), PrimaryKey: ['Id'] }) as any;

function insert(set: SubjectSet, name: string): Subject {
  return set.add(new Subject(new Row() as any, desc(name), SubjectOperation.Insert));
}

function update(set: SubjectSet, name: string, pk: any): Subject {
  return set.add(new Subject(new Row(pk) as any, desc(name), SubjectOperation.Update));
}

/** `child` needs `parent`'s key in column `column`. */
function needs(child: Subject, column: string, parent: Subject): void {
  child.PendingForeignKeys.push({ Column: column, Target: parent.Model });
}

describe('SubjectSorter', () => {
  it('keeps independent inserts in traversal order', () => {
    const set = new SubjectSet();
    const a = insert(set, 'A');
    const b = insert(set, 'B');

    expect(new SubjectSorter().sort(set).Inserts).to.deep.equal([a, b]);
  });

  it('puts a parent before the child that references it', () => {
    const set = new SubjectSet();
    const child = insert(set, 'Child');
    const parent = insert(set, 'Parent');
    needs(child, 'parent_id', parent);

    expect(new SubjectSorter().sort(set).Inserts).to.deep.equal([parent, child]);
  });

  it('orders a three-level chain root first', () => {
    const set = new SubjectSet();
    const c = insert(set, 'C');
    const b = insert(set, 'B');
    const a = insert(set, 'A');
    needs(c, 'b_id', b);
    needs(b, 'a_id', a);

    expect(new SubjectSorter().sort(set).Inserts).to.deep.equal([a, b, c]);
  });

  it('ignores a dependency on a model that already has a key', () => {
    const set = new SubjectSet();
    const child = insert(set, 'Child');
    const existing = update(set, 'Parent', 7);
    needs(child, 'parent_id', existing);

    const plan = new SubjectSorter().sort(set);

    expect(plan.Inserts).to.deep.equal([child]);
    expect(child.DeferredForeignKeys).to.deep.equal([]);
  });

  it('defers a self-referencing cycle instead of throwing', () => {
    const set = new SubjectSet();
    const a = insert(set, 'Node');
    const b = insert(set, 'Node');
    needs(a, 'parent_id', b);
    needs(b, 'parent_id', a);

    const plan = new SubjectSorter().sort(set);

    expect(plan.Inserts.length).to.equal(2);
    const deferred = plan.Inserts.filter((s) => s.DeferredForeignKeys.length > 0);
    expect(deferred.length).to.be.greaterThan(0);
    expect(plan.Updates).to.include(deferred[0]);
  });

  it('does not defer a self-reference that is not actually cyclic', () => {
    const set = new SubjectSet();
    const child = insert(set, 'Node');
    const parent = insert(set, 'Node');
    needs(child, 'parent_id', parent);

    const plan = new SubjectSorter().sort(set);

    expect(plan.Inserts).to.deep.equal([parent, child]);
    expect(child.DeferredForeignKeys).to.deep.equal([]);
    expect(child.PendingForeignKeys.length).to.equal(1);
  });

  it('throws naming both models on a cycle between two different models', () => {
    const set = new SubjectSet();
    const a = insert(set, 'CycleA');
    const b = insert(set, 'CycleB');
    needs(a, 'b_id', b);
    needs(b, 'a_id', a);

    expect(() => new SubjectSorter().sort(set)).to.throw(OrmCycleException, /CycleA/);
    expect(() => new SubjectSorter().sort(set)).to.throw(OrmCycleException, /CycleB/);
  });

  it('collects update subjects in traversal order', () => {
    const set = new SubjectSet();
    const a = update(set, 'A', 1);
    insert(set, 'B');
    const c = update(set, 'C', 2);

    expect(new SubjectSorter().sort(set).Updates).to.deep.equal([a, c]);
  });

  it('excludes no-op subjects from every bucket', () => {
    const set = new SubjectSet();
    set.add(new Subject(new Row(1) as any, desc('A'), SubjectOperation.None));

    const plan = new SubjectSorter().sort(set);

    expect(plan.Inserts).to.deep.equal([]);
    expect(plan.Updates).to.deep.equal([]);
  });

  // A clean child re-parented to another owner classifies as None - its own columns still
  // match its snapshot. It only becomes an UPDATE once the executor writes the new owner key
  // onto it, so it has to reach the update phase to be reconsidered at all.
  it('keeps a no-op subject that carries a pending foreign key in Updates', () => {
    const set = new SubjectSet();
    const owner = update(set, 'Owner', 2);
    const child = set.add(new Subject(new Row(1) as any, desc('Child'), SubjectOperation.None));
    needs(child, 'owner_id', owner);

    expect(new SubjectSorter().sort(set).Updates).to.deep.equal([owner, child]);
  });

  it('passes junctions through untouched', () => {
    const set = new SubjectSet();
    const j = { Descriptor: {}, JunctionDescriptor: {}, Owner: {}, Added: [], RemovedKeys: [] } as any;
    set.Junctions.push(j);

    expect(new SubjectSorter().sort(set).Junctions).to.deep.equal([j]);
  });

  it('handles orphans of a model that is nowhere in the insert order', () => {
    const set = new SubjectSet();
    const o = { Descriptor: {}, TargetDescriptor: desc('Gone'), Policy: 'delete', PrimaryKeys: [1] } as any;
    set.Orphans.push(o);

    expect(new SubjectSorter().sort(set).Orphans).to.deep.equal([o]);
  });

  it('handles orphans of children before orphans of parents', () => {
    const set = new SubjectSet();
    const parent = insert(set, 'Parent');
    const child = insert(set, 'Child');
    needs(child, 'parent_id', parent);

    const parentOrphan = { Descriptor: {}, TargetDescriptor: desc('Parent'), Policy: 'delete', PrimaryKeys: [1] } as any;
    const childOrphan = { Descriptor: {}, TargetDescriptor: desc('Child'), Policy: 'delete', PrimaryKeys: [2] } as any;
    set.Orphans.push(parentOrphan, childOrphan);

    expect(new SubjectSorter().sort(set).Orphans).to.deep.equal([childOrphan, parentOrphan]);
  });
});
