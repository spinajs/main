import * as chai from 'chai';
import 'mocha';

import { RelationColumnTerm, RelationOwnerTerm, RelationSelfTerm } from '../../src/lists/relation-terms.js';
import { SESSION_PRINCIPALS, rlsContext } from '../../src/rls/index.js';

const expect = chai.expect;

const ctx = rlsContext({
  type: 'doc',
  table: 'docs',
  idColumn: 'id',
  ancestorTable: 'authz_resource_ancestor',
  relations: (name) => ({ owner: { column: 'author_id' }, self: { column: 'user_id' }, editor: { column: 'editor_id', typeColumn: 'editor_type' } })[name],
});

describe('relation terms as RLS SQL', () => {
  it('owner: the column holds a user principal of the session', () => {
    expect(new RelationOwnerTerm().renderSql({ principals: [{ type: 'user', id: 'ignored' }] }, ctx)).to.equal(`"docs"."author_id"::text IN (SELECT principal_id FROM (${SESSION_PRINCIPALS}) AS sp WHERE principal_type = 'user')`);
  });

  it('self: the row is the user principal of the session', () => {
    expect(new RelationSelfTerm().renderSql({ principals: [] }, ctx)).to.equal(`"docs"."user_id"::text IN (SELECT principal_id FROM (${SESSION_PRINCIPALS}) AS sp WHERE principal_type = 'user')`);
  });

  it('a column relation with a type column matches type and id', () => {
    expect(new RelationColumnTerm().renderSql({ relation: 'editor', principals: [] }, ctx)).to.equal(`("docs"."editor_type"::text, "docs"."editor_id"::text) IN (SELECT principal_type, principal_id FROM (${SESSION_PRINCIPALS}) AS sp)`);
  });

  it('refuses a relation the table does not have', () => {
    expect(() => new RelationColumnTerm().renderSql({ relation: 'reviewer', principals: [] }, ctx)).to.throw("resource type 'doc' has no reviewer column");
  });

  it('reads the principal from the session, never from the args', () => {
    expect(new RelationOwnerTerm().renderSql({ principals: [{ type: 'user', id: "x' OR true --" }] }, ctx)).to.not.include('OR true');
  });
});
