import { RelationName, SortOrder } from '@spinajs/orm';
import { Include, Sort, readSort } from '../../src/index.js';
import { Sorted } from '../models/Sorted.js';
import { Belongs } from '../models/Belongs.js';

class SortedSubclass extends Sorted {}

export class Controller {
  public list(@Sort(Sorted, { default: 'Name', order: SortOrder.DESC }) sort: Sort<Sorted>, @Include(Sorted, ['Belongs', 'TestsTwos']) include: RelationName<Sorted>[]) {
    return Sorted.query().order(sort.column, sort.order).populate(include);
  }

  // @ts-expect-error the default must be a column of the model
  public unknownDefault(@Sort(Sorted, { default: 'Nope' }) sort: Sort<Sorted>) {
    return sort;
  }

  // @ts-expect-error a relation is not a column
  public relationDefault(@Sort(Sorted, { default: 'Belongs' }) sort: Sort<Sorted>) {
    return sort;
  }

  public resolvedSubclass(@Sort(Sorted, { default: 'Name', resolve: () => SortedSubclass }) sort: Sort<Sorted>) {
    return sort;
  }

  // @ts-expect-error resolve returns the model or a subclass of it
  public resolvedUnrelated(@Sort(Sorted, { default: 'Name', resolve: () => Belongs }) sort: Sort<Sorted>) {
    return sort;
  }

  // @ts-expect-error the list holds relations of the model only
  public unknownInclude(@Include(Sorted, ['Nope']) include: RelationName<Sorted>[]) {
    return include;
  }

  // @ts-expect-error a column is not a relation
  public columnInclude(@Include(Sorted, ['Name']) include: RelationName<Sorted>[]) {
    return include;
  }
}

export const typedColumn: 'Id' | 'Name' | 'Secret' = ({} as Sort<Sorted>).column;

// @ts-expect-error a plain string is not a column of the model
export const untyped: Sort<Sorted> = { column: 'Name' as string, order: SortOrder.ASC };

export const read: Sort<Sorted> = readSort<Sorted>(undefined, ['Id', 'Name'], { column: 'Name' });

// @ts-expect-error the allowlist holds columns of the model only
readSort<Sorted>(undefined, ['Nope'], { column: 'Name' });

// @ts-expect-error a plain string does not populate in strict mode
Sorted.query().populate(['Belongs'] as string[]);
