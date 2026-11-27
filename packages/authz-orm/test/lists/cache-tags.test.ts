import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';

import { RelationColumnTerm, RelationOwnerTerm, RelationSelfTerm } from '../../src/lists/relation-terms.js';

const expect = chai.expect;

const principals = [
  { type: 'user', id: 'alice' },
  { type: 'team', id: 'red' },
];

describe('cacheTags of the relation terms', () => {
  it('names the subject tag of every principal the term matches', () => {
    const tags = ['subject:user:alice', 'subject:team:red'];

    expect(new RelationOwnerTerm().cacheTags({ principals })).to.deep.equal(tags);
    expect(new RelationSelfTerm().cacheTags({ principals })).to.deep.equal(tags);
    expect(new RelationColumnTerm().cacheTags({ relation: 'assignee', principals })).to.deep.equal(tags);
  });

  it('refuses args it would refuse to apply', () => {
    expect(() => new RelationOwnerTerm().cacheTags({ principals: 'alice' })).to.throw(AuthzConfigError, /relation\.owner args must be/);
  });
});
