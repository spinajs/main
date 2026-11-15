import 'mocha';
import { expect } from 'chai';
import { Model, ModelBase, Primary, Sortable, SortOrder, extractModelDescriptor } from '@spinajs/orm';
import { InvalidArgument } from '@spinajs/exceptions';
import { Sort } from '../src/index.js';
import { Sorted } from './models/Sorted.js';

@Model('sort_include_unsortable')
class Unsortable extends ModelBase<Unsortable> {
  @Primary()
  public Id: number;
}

@Model('sort_include_child')
class SortedChild extends Sorted {
  @Sortable()
  public Secret: string;
}

describe('@Sortable', () => {
  it('records the sortable columns on the model descriptor', () => {
    expect(extractModelDescriptor(Sorted)!.Sortable).to.deep.eq(['Id', 'Name']);
  });

  it('adds to the columns a parent model declares', () => {
    expect(extractModelDescriptor(SortedChild)!.Sortable).to.have.members(['Id', 'Name', 'Secret']);
  });
});

describe('@Sort', () => {
  it('accepts a sortable default column', () => {
    expect(() => Sort(Sorted, { default: 'Name', order: SortOrder.DESC })).to.not.throw();
  });

  it('throws when the default column is not sortable', () => {
    expect(() => Sort(Sorted, { default: 'Secret' })).to.throw(InvalidArgument, "@Sort(Sorted): default column 'Secret' is not @Sortable(). Sortable columns are: Id, Name");
  });

  it('throws when the model declares no sortable column', () => {
    expect(() => Sort(Unsortable, { default: 'Id' })).to.throw(InvalidArgument, '@Sort(Unsortable): the model declares no @Sortable() column');
  });
});
