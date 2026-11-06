import 'mocha';
import { expect } from 'chai';

import { defineAuthzSchema } from '../../src/index.js';

describe('defineAuthzSchema', () => {
  const schema = defineAuthzSchema(
    {
      folder: { relations: { owner: ['user'], viewer: ['user', 'group#member'] }, permissions: { view: { union: ['viewer', 'owner'] } } },
      doc: { relations: { parent: ['folder'], editor: ['user'] }, permissions: { view: { union: ['editor', 'parent->view'] }, edit: 'editor' } },
      group: { relations: { member: ['user'] } },
    },
    { permissions: { 'doc:read': 'doc#view', 'doc:update': 'doc#edit' } },
  );

  it('returns the plain authz.rebac namespaces and permissions values', () => {
    expect(schema.namespaces.doc.permissions.view).to.deep.equal({ union: ['editor', 'parent->view'] });
    expect(schema.permissions).to.deep.equal({ 'doc:read': 'doc#view', 'doc:update': 'doc#edit' });
    expect(defineAuthzSchema({ user: {} }).permissions).to.deep.equal({});
  });

  it('types relation names, arrows into the tupleset target and permission targets', () => {
    // @ts-expect-error 'veiw' is not a relation of folder
    defineAuthzSchema({ folder: { relations: { parent: ['folder'] }, permissions: { view: 'parent->veiw' } } });
    // @ts-expect-error 'raed' is not a relation of doc
    defineAuthzSchema({ doc: { relations: { reader: ['user'] } } }, { permissions: { 'doc:read': 'doc#raed' } });
    // @ts-expect-error 'nobody' is not a relation of doc
    defineAuthzSchema({ doc: { relations: { reader: ['user'] }, permissions: { read: { union: ['reader', 'nobody'] } } } });
    expect(defineAuthzSchema({ folder: { relations: { parent: ['folder'], viewer: ['user'] }, permissions: { view: { union: ['viewer', 'parent->view'] } } } }).namespaces.folder.relations.parent).to.deep.equal(['folder']);
  });
});
