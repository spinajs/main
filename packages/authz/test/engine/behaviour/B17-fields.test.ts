import * as chai from 'chai';
import 'mocha';

import { FieldCombiner } from '../../../src/engine/fields.js';
import { FALSE, TRUE, compileFieldGlobs, filterObject } from '../../../src/index.js';
import type { FieldSet, ResourceFilter, Vote } from '../../../src/index.js';

const expect = chai.expect;

const vote = (model: string, permitWhen: ResourceFilter, denyWhen: ResourceFilter, fields?: FieldSet): Vote => Object.freeze({ model, permitWhen, denyWhen, cacheable: true, ...(fields ? { fields } : {}) });
const owner: ResourceFilter = Object.freeze({ op: 'relation', relation: 'owner' });
const serviceOnly: ResourceFilter = Object.freeze({ op: 'cmp', field: 'kind', cmp: 'eq', value: 'internal' });
const allows = (globs: readonly string[], path: string) => compileFieldGlobs(globs).allows(path);

describe('B17: fields (core)', () => {
  const combiner = new FieldCombiner({ neverRead: ['Password'] });

  it('B17: read/write = union over permitting votes', () => {
    const r = combiner.combine('deny-overrides', [vote('rbac', TRUE, FALSE, { read: ['Name', 'Email'], write: ['Name'] }), vote('abac', owner, FALSE, { read: ['Phone'], write: ['Phone'] }), vote('other', FALSE, FALSE, { read: ['Salary'] })]);
    expect(r.read).to.deep.equal(['Email', 'Name', 'Phone']);
    expect(r.write).to.deep.equal(['Name', 'Phone']);
  });

  it('B17: minus hide from denying votes', () => {
    const r = combiner.combine('deny-overrides', [vote('rbac', TRUE, FALSE), vote('abac', FALSE, serviceOnly, { hide: ['Salary'] })]);
    expect(allows(r.read, 'Salary')).to.equal(false);
    expect(allows(r.write, 'Salary')).to.equal(false);
    expect(allows(r.read, 'Name')).to.equal(true);
  });

  it('B17: minus neverRead (default Password) on read; write is untouched', () => {
    const r = combiner.combine('deny-overrides', [vote('rbac', TRUE, FALSE)]);
    expect(allows(r.read, 'Password')).to.equal(false);
    expect(allows(r.read, 'Name')).to.equal(true);
    expect(allows(r.write, 'Password')).to.equal(true);
  });

  it('B17: `!X` negations and `A.*` globs work', () => {
    const r = combiner.combine('deny-overrides', [vote('rbac', TRUE, FALSE, { read: ['*', '!Salary', 'Address.*', '!Address.Private'] })]);
    expect(allows(r.read, 'Name')).to.equal(true);
    expect(allows(r.read, 'Salary')).to.equal(false);
    expect(allows(r.read, 'Address.City')).to.equal(true);
    expect(allows(r.read, 'Address.Private')).to.equal(false);
  });

  it('B17: the output filter keeps only readable fields', () => {
    const r = combiner.combine('deny-overrides', [vote('rbac', TRUE, FALSE, { read: ['*', '!Salary'] })]);
    const user = { Name: 'Ann', Salary: 100, Password: 'hash', Address: { City: 'X' } };
    expect(filterObject(r.read, user)).to.deep.equal({ Name: 'Ann', Address: { City: 'X' } });
  });

  it('B17: a denial reads and writes nothing', () => {
    expect(combiner.combine('deny-overrides', [vote('rbac', FALSE, TRUE, { read: ['*'] })])).to.deep.equal({ read: [], write: [] });
  });
});
