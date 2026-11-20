import * as chai from 'chai';
import 'mocha';
import { AuthzConfigError } from '@spinajs/authz';
import { DeleteQueryExtension, SelectQueryExtension, UpdateQueryExtension } from '@spinajs/orm';
import type { QueryBuilder } from '@spinajs/orm';

import { AuthzAccessFieldsExtension, AuthzDeleteExtension, AuthzSelectExtension, AuthzUpdateExtension } from '../../src/index.js';
import { marksOf, setMarks } from '../../src/marker.js';
import type { AccessMarks } from '../../src/marker.js';

const expect = chai.expect;

describe('authz-orm query extensions', () => {
  it('add accessible, unscoped and within to select, update and delete builders', () => {
    const select = new AuthzSelectExtension();
    const update = new AuthzUpdateExtension();
    const remove = new AuthzDeleteExtension();
    expect(select).to.be.instanceOf(SelectQueryExtension);
    expect(update).to.be.instanceOf(UpdateQueryExtension);
    expect(remove).to.be.instanceOf(DeleteQueryExtension);
    expect(Object.keys(select.methods)).to.deep.equal(['accessible', 'unscoped', 'within']);
    expect(update.methods).to.equal(select.methods);
    expect(remove.methods).to.equal(select.methods);
  });

  it('share one name, which collides on none of the three builders', () => {
    expect([new AuthzSelectExtension().name, new AuthzUpdateExtension().name, new AuthzDeleteExtension().name]).to.deep.equal(['authz-orm', 'authz-orm', 'authz-orm']);
  });

  it('add withAccess and withFields to select builders only', () => {
    const extension = new AuthzAccessFieldsExtension();
    expect(extension).to.be.instanceOf(SelectQueryExtension);
    expect(Object.keys(extension.methods)).to.deep.equal(['withAccess', 'withFields']);
  });

  it('copy the access marks onto a clone', () => {
    const source = {};
    const clone = {};
    setMarks(source, { accessible: 'task:read', onNone: 'empty' });
    new AuthzSelectExtension().onClone(source as QueryBuilder, clone as QueryBuilder);
    expect(marksOf(clone)).to.deep.equal({ accessible: 'task:read', onNone: 'empty' });
  });

  it('leave the clone of an unmarked query unmarked', () => {
    const clone = {};
    new AuthzSelectExtension().onClone({} as QueryBuilder, clone as QueryBuilder);
    expect(marksOf(clone)).to.equal(undefined);
  });

  it('refuse the merge of a query that carries a filtering mark', () => {
    const filtering: AccessMarks[] = [{ accessible: 'task:read' }, { within: [[{ type: 'project', id: 'p1' }]] }, { withAccess: ['task:read'] }, { withFields: 'task:read' }];
    for (const marks of filtering) {
      const source = {};
      setMarks(source, marks);
      expect(() => new AuthzSelectExtension().onMerge(source as QueryBuilder)).to.throw(AuthzConfigError, 'merged into another query');
    }
  });

  it('let an unmarked query and an unscoped one be merged', () => {
    const unscoped = {};
    setMarks(unscoped, { unscoped: 'nightly export' });
    expect(() => new AuthzSelectExtension().onMerge({} as QueryBuilder)).not.to.throw();
    expect(() => new AuthzSelectExtension().onMerge(unscoped as QueryBuilder)).not.to.throw();
  });
});
