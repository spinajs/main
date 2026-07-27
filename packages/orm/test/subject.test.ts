/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from 'chai';
import 'mocha';
import { Subject, SubjectOperation, SubjectSet } from '../src/subject.js';

class Fake {
  constructor(public PrimaryKeyValue: any) {}
}

const desc = (name: string) => ({ Name: name, PrimaryKey: ['Id'], TableName: name.toLowerCase() }) as any;

describe('Subject', () => {
  it('starts with empty column and foreign-key collections', () => {
    const s = new Subject(new Fake(1) as any, desc('Order'), SubjectOperation.Update);

    expect(s.ChangedColumns).to.deep.equal([]);
    expect(s.PendingForeignKeys).to.deep.equal([]);
    expect(s.DeferredForeignKeys).to.deep.equal([]);
    expect(s.RelationDeltas).to.deep.equal([]);
  });

  it('reports an identity naming the model and key', () => {
    expect(new Subject(new Fake(7) as any, desc('Order'), SubjectOperation.Update).Identity).to.equal('Order#7');
  });

  it('reports a placeholder identity for a model with no key yet', () => {
    expect(new Subject(new Fake(undefined) as any, desc('Order'), SubjectOperation.Insert).Identity).to.equal('Order#<new>');
  });

  it('renders a composite key tuple readably', () => {
    expect(new Subject(new Fake([7, 'ab']) as any, desc('Order'), SubjectOperation.Update).Identity).to.equal('Order#7,ab');
  });

  it('reports a placeholder identity when part of a composite key is missing', () => {
    expect(new Subject(new Fake([7, undefined]) as any, desc('Order'), SubjectOperation.Insert).Identity).to.equal('Order#<new>');
  });
});

describe('SubjectSet', () => {
  it('starts empty', () => {
    const set = new SubjectSet();

    expect(set.Subjects).to.deep.equal([]);
    expect(set.Junctions).to.deep.equal([]);
    expect(set.Orphans).to.deep.equal([]);
    expect(set.IsEmpty).to.equal(true);
  });

  it('add stores the subject and returns it', () => {
    const set = new SubjectSet();
    const s = new Subject(new Fake(1) as any, desc('Order'), SubjectOperation.Update);

    expect(set.add(s)).to.equal(s);
    expect(set.Subjects).to.deep.equal([s]);
  });

  it('add returns the existing subject when the same model instance is added twice', () => {
    const set = new SubjectSet();
    const model = new Fake(1) as any;
    const first = new Subject(model, desc('Order'), SubjectOperation.Update);
    const second = new Subject(model, desc('Order'), SubjectOperation.Insert);

    set.add(first);

    expect(set.add(second)).to.equal(first);
    expect(set.Subjects.length).to.equal(1);
  });

  it('find looks a subject up by model instance', () => {
    const set = new SubjectSet();
    const model = new Fake(1) as any;
    const s = set.add(new Subject(model, desc('Order'), SubjectOperation.Update));

    expect(set.find(model)).to.equal(s);
    expect(set.find(new Fake(1) as any)).to.equal(undefined);
  });

  it('is not empty once it carries only a junction delta', () => {
    const set = new SubjectSet();
    set.Junctions.push({} as any);

    expect(set.IsEmpty).to.equal(false);
  });

  it('is not empty once it carries only an orphan delta', () => {
    const set = new SubjectSet();
    set.Orphans.push({} as any);

    expect(set.IsEmpty).to.equal(false);
  });

  it('is empty when every subject is a no-op', () => {
    const set = new SubjectSet();
    set.add(new Subject(new Fake(1) as any, desc('Order'), SubjectOperation.None));

    expect(set.IsEmpty).to.equal(true);
  });
});
