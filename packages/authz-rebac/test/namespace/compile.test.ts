import * as chai from 'chai';
import 'mocha';
import { AuthzConfigError } from '@spinajs/authz';

import { NamespaceSchema } from '../../src/index.js';
import type { NamespaceConfig, PermissionMap } from '../../src/index.js';
import { NAMESPACES, PERMISSIONS, d1, ref, set, tuple, user } from '../support/world.js';

const expect = chai.expect;

const compileError = (namespaces: NamespaceConfig, permissions: PermissionMap = {}): string => {
  try {
    NamespaceSchema.compile(namespaces, permissions);
  } catch (e) {
    expect(e).to.be.instanceOf(AuthzConfigError);
    return (e as Error).message;
  }
  throw new Error('expected an AuthzConfigError');
};

describe('authz-rebac: namespace compiler', () => {
  describe('a valid configuration', () => {
    const schema = NamespaceSchema.compile(NAMESPACES, PERMISSIONS);

    it('compiles relations into direct types and subject sets', () => {
      expect(schema.relation('doc', 'viewer')).to.deep.equal({ name: 'viewer', direct: ['user'], sets: [{ type: 'group', relation: 'member' }] });
      expect(schema.relation('folder', 'parent')).to.deep.equal({ name: 'parent', direct: ['folder'], sets: [] });
      expect(schema.relation('doc', 'read')).to.equal(undefined);
      expect(schema.relation('nope', 'viewer')).to.equal(undefined);
    });

    it('compiles rewrites, short forms included', () => {
      expect(schema.permission('doc', 'read')).to.deep.equal({
        kind: 'union',
        children: [
          { kind: 'computed', name: 'owner' },
          { kind: 'computed', name: 'viewer' },
          { kind: 'ttu', tupleset: 'parent', computed: 'view' },
        ],
      });
      expect(schema.permission('doc', 'edit')).to.deep.equal({ kind: 'intersection', children: [{ kind: 'computed', name: 'editor' }, { kind: 'computed', name: 'approved' }] });
      expect(schema.permission('doc', 'view')).to.deep.equal({ kind: 'exclusion', base: { kind: 'computed', name: 'read' }, subtract: { kind: 'computed', name: 'banned' } });
      const long = NamespaceSchema.compile({ doc: { relations: { parent: ['doc'], owner: ['user'] }, permissions: { a: { computed: 'owner' }, b: { tupleToUserset: { tupleset: 'parent', computed: 'a' } } } } });
      expect(long.permission('doc', 'a')).to.deep.equal({ kind: 'computed', name: 'owner' });
      expect(long.permission('doc', 'b')).to.deep.equal({ kind: 'ttu', tupleset: 'parent', computed: 'a' });
    });

    it('maps permissions to their targets and knows every name', () => {
      expect(schema.targets.get('doc:read')).to.deep.equal({ type: 'doc', name: 'read' });
      expect(schema.targets.get('folder:read')).to.deep.equal({ type: 'folder', name: 'view' });
      expect([...schema.targets.keys()].sort()).to.deep.equal(['doc:edit', 'doc:read', 'doc:view', 'folder:read']);
      expect(schema.has('doc', 'owner')).to.equal(true);
      expect(schema.has('doc', 'read')).to.equal(true);
      expect(schema.has('doc', 'nope')).to.equal(false);
      expect([...schema.namespaces.keys()].sort()).to.deep.equal(['doc', 'folder', 'group', 'user']);
    });

    it('hashes the configuration: equal for equal input, changed by any change', () => {
      expect(NamespaceSchema.compile(NAMESPACES, PERMISSIONS).hash()).to.equal(schema.hash());
      expect(NamespaceSchema.compile(NAMESPACES, { ...PERMISSIONS, 'doc:read': 'doc#view' }).hash()).to.not.equal(schema.hash());
      expect(NamespaceSchema.compile({ ...NAMESPACES, user: { relations: { self: ['user'] } } }, PERMISSIONS).hash()).to.not.equal(schema.hash());
    });

    it('tells why a tuple does not fit', () => {
      expect(schema.problem(tuple(d1, 'owner', user('alice')))).to.equal(undefined);
      expect(schema.problem(tuple(d1, 'viewer', set('group', 'eng', 'member')))).to.equal(undefined);
      expect(schema.problem(tuple(d1, 'parent', { type: 'folder', id: 'f1' }))).to.equal(undefined);
      expect(schema.problem(tuple(ref('note', 'n1'), 'owner', user('alice')))?.code).to.equal('unknown_relation');
      expect(schema.problem(tuple(d1, 'read', user('alice')))?.code).to.equal('unknown_relation');
      expect(schema.problem(tuple(d1, 'nope', user('alice')))?.code).to.equal('unknown_relation');
      expect(schema.problem(tuple(d1, 'owner', { type: 'group', id: 'eng' }))?.code).to.equal('subject_not_allowed');
      expect(schema.problem(tuple(d1, 'owner', set('group', 'eng', 'member')))?.code).to.equal('subject_not_allowed');
      expect(schema.problem(tuple(d1, 'viewer', set('group', 'eng', 'owner')))?.code).to.equal('subject_not_allowed');
    });
  });

  describe('refuses at compile time', () => {
    it('a name that is both a relation and a permission', () => {
      expect(compileError({ doc: { relations: { viewer: ['user'] }, permissions: { viewer: 'viewer' } } })).to.include('doc#viewer is both a relation and a permission');
    });

    it('a computed name the namespace lacks', () => {
      expect(compileError({ doc: { relations: { viewer: ['user'] }, permissions: { read: { union: ['viewer', 'nope'] } } } })).to.include('doc#read names unknown relation or permission "nope"');
    });

    it('a tuple-to-userset over a name that is no relation, admits no object, or misses its target', () => {
      expect(compileError({ doc: { relations: { viewer: ['user'] }, permissions: { read: 'nope->view' } } })).to.include('doc#read: tupleset "nope" is not a relation of doc');
      expect(compileError({ group: { relations: { member: ['user'] } }, doc: { relations: { parent: ['group#member'] }, permissions: { read: 'parent->member' } } })).to.include('doc#read: tupleset "parent" admits no object type');
      expect(compileError({ folder: { relations: { viewer: ['user'] } }, doc: { relations: { parent: ['folder'] }, permissions: { read: 'parent->view' } } })).to.include('doc#read: folder has no relation or permission "view"');
    });

    it('a subject type naming a missing namespace or relation', () => {
      expect(compileError({ doc: { relations: { viewer: ['team#member'] } } })).to.include('doc#viewer: subject type "team#member" names no namespace team');
      expect(compileError({ group: { relations: { member: ['user'] } }, doc: { relations: { viewer: ['group#nope'] } } })).to.include('doc#viewer: subject type "group#nope" names no relation or permission of group');
    });

    it('a cycle of computed usersets on one namespace', () => {
      expect(compileError({ doc: { relations: { owner: ['user'] }, permissions: { a: { union: ['owner', 'b'] }, b: 'a' } } })).to.include('cycle');
    });

    it('empty unions and intersections, and shapes that are no rewrite', () => {
      expect(compileError({ doc: { relations: { owner: ['user'] }, permissions: { a: { union: [] } } } })).to.include('union needs at least one rewrite');
      expect(compileError({ doc: { relations: { owner: ['user'] }, permissions: { a: { intersection: [] } } } })).to.include('intersection needs at least one rewrite');
      expect(compileError({ doc: { relations: { owner: ['user'] }, permissions: { a: { foo: 1 } as never } } })).to.include('doc#a: not a rewrite');
    });

    it('names outside the name pattern', () => {
      expect(compileError({ doc: { relations: { 'bad name': ['user'] } } })).to.include('"bad name" is not a valid name');
      expect(compileError({ 'do:c': { relations: { owner: ['user'] } } })).to.include('"do:c" is not a valid name');
    });

    it('a permission map entry that names no target', () => {
      expect(compileError(NAMESPACES, { 'doc:x': 'doc#nope' })).to.include('doc:x maps to unknown doc#nope');
      expect(compileError(NAMESPACES, { 'doc:x': 'doc' })).to.include('doc:x must map to "<namespace>#<relation or permission>"');
    });
  });
});
