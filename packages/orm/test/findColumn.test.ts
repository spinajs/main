import 'mocha';
import { expect } from 'chai';
import { findColumn } from '../src/helpers.js';
import type { IColumnDescriptor } from '../src/interfaces.js';

const columns = (...names: string[]): IColumnDescriptor[] => names.map((Name) => ({ Name }) as IColumnDescriptor);

describe('findColumn', () => {
  it('returns the exact name before one that differs only in case', () => {
    expect(findColumn(columns('role', 'Role'), 'Role')?.Name).to.eq('Role');
  });

  it('returns the only column equal ignoring case, spelled as the table spells it', () => {
    expect(findColumn(columns('Id', 'Role'), 'ROLE')?.Name).to.eq('Role');
  });

  it('returns nothing when two columns differ from the name only in case', () => {
    expect(findColumn(columns('role', 'ROLE'), 'Role')).to.eq(undefined);
  });

  it('returns nothing for a missing column or a missing table', () => {
    expect(findColumn(columns('Id'), 'Role')).to.eq(undefined);
    expect(findColumn(null, 'Role')).to.eq(undefined);
    expect(findColumn(undefined, 'Role')).to.eq(undefined);
  });
});
