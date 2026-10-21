import type { PrincipalRef, ResourceRef } from '@spinajs/authz';

import { userPrincipal } from '../principals.js';
import type { Tuple } from '../rebac.js';
import { combine, fixture, ref } from './dsl.js';
import type { Case, DecisionExpectation, World } from './types.js';

const d1 = ref('doc', 'd1');
const d2 = ref('doc', 'd2');
const d9 = ref('doc', 'd9');
const f0 = ref('folder', 'f0');
const f1 = ref('folder', 'f1');

const NAMES = ['alice', 'bob', 'carol', 'dave', 'eve', 'olga'] as const;
const principals = Object.fromEntries(NAMES.map((n) => [n, userPrincipal(n)]));

const u = (id: string): PrincipalRef => ({ type: 'user', id });
const members = (type: string, id: string) => ({ object: ref(type, id), relation: 'member' });
const t = (object: ResourceRef, relation: string, subject: Tuple['subject']): Tuple => ({ object, relation, subject });

// Namespaces as authz.rebac.namespaces holds them: groups nest, docs sit in folders, folders in folders.
const NAMESPACES = {
  user: {},
  group: { relations: { member: ['user', 'group#member'] } },
  folder: { relations: { parent: ['folder'], viewer: ['user', 'group#member'] }, permissions: { view: { union: ['viewer', 'parent->view'] } } },
  doc: {
    relations: { parent: ['folder'], owner: ['user'], viewer: ['user', 'group#member'], editor: ['user'], approved: ['user'], banned: ['user'] },
    permissions: {
      read: { union: ['owner', 'viewer', 'parent->view'] },
      edit: { intersection: ['editor', 'approved'] },
      view: { exclusion: { base: 'read', subtract: 'banned' } },
    },
  },
};

const PERMISSIONS = { 'doc:read': 'doc#read', 'doc:edit': 'doc#edit', 'doc:view': 'doc#view', 'folder:read': 'folder#view' };

const world = (tuples: readonly Tuple[], limit?: { readonly maxDepth: number }): World => ({
  permissions: [...['doc:read', 'doc:edit', 'doc:view'].map((name) => ({ name, types: ['doc'] })), { name: 'folder:read', types: ['folder'] }],
  principals,
  combine: combine('deny-overrides', 'rebac'),
  rebac: { tuples },
  config: { rebac: { namespaces: NAMESPACES, permissions: PERMISSIONS, ...(limit ? { limit } : {}) } },
});

const ALLOWED: DecisionExpectation = { allowed: true };
const DENIED: DecisionExpectation = { allowed: false, reason: 'no_access' };
const MODEL_ERROR: DecisionExpectation = { allowed: false, reason: { code: 'model_error', model: 'rebac' } };

const check = (as: string, permission: string, resource: ResourceRef, expect: DecisionExpectation) => ({ check: { as, permission, resource }, expect });

const cases: Case[] = [
  {
    name: 'a direct tuple grants its subject and nobody else',
    world: world([t(d1, 'owner', u('alice'))]),
    steps: [check('alice', 'doc:read', d1, ALLOWED), check('bob', 'doc:read', d1, DENIED), check('alice', 'doc:read', d2, DENIED)],
  },
  {
    name: 'a subject set grants its members, nested sets included',
    world: world([t(d1, 'viewer', members('group', 'eng')), t(ref('group', 'eng'), 'member', u('bob')), t(ref('group', 'eng'), 'member', members('group', 'ops')), t(ref('group', 'ops'), 'member', u('olga'))]),
    steps: [check('bob', 'doc:read', d1, ALLOWED), check('olga', 'doc:read', d1, ALLOWED), check('eve', 'doc:read', d1, DENIED)],
  },
  {
    name: 'tuple-to-userset: the viewers of a parent folder read its docs, over nested folders',
    world: world([t(d2, 'parent', { type: 'folder', id: 'f1' }), t(f1, 'parent', { type: 'folder', id: 'f0' }), t(f1, 'viewer', u('dave')), t(f0, 'viewer', u('carol'))]),
    steps: [check('dave', 'doc:read', d2, ALLOWED), check('carol', 'doc:read', d2, ALLOWED), check('carol', 'folder:read', f1, ALLOWED), check('dave', 'folder:read', f0, DENIED), check('eve', 'doc:read', d2, DENIED)],
  },
  {
    name: 'union: any branch grants',
    world: world([t(d1, 'owner', u('alice')), t(d1, 'viewer', u('bob')), t(d1, 'parent', { type: 'folder', id: 'f1' }), t(f1, 'viewer', u('carol'))]),
    steps: [check('alice', 'doc:read', d1, ALLOWED), check('bob', 'doc:read', d1, ALLOWED), check('carol', 'doc:read', d1, ALLOWED), check('eve', 'doc:read', d1, DENIED)],
  },
  {
    name: 'intersection: every branch must hold',
    world: world([t(d1, 'editor', u('alice')), t(d1, 'approved', u('alice')), t(d1, 'editor', u('bob')), t(d1, 'approved', u('carol'))]),
    steps: [check('alice', 'doc:edit', d1, ALLOWED), check('bob', 'doc:edit', d1, DENIED), check('carol', 'doc:edit', d1, DENIED)],
  },
  {
    name: 'exclusion: the subtracted relation takes access away from subjects the base grants',
    world: world([t(d1, 'viewer', members('group', 'eng')), t(ref('group', 'eng'), 'member', u('bob')), t(ref('group', 'eng'), 'member', u('olga')), t(d1, 'banned', u('bob')), t(d1, 'banned', u('eve'))]),
    steps: [check('olga', 'doc:view', d1, ALLOWED), check('bob', 'doc:view', d1, DENIED), check('bob', 'doc:read', d1, ALLOWED), check('eve', 'doc:view', d1, DENIED)],
  },
  {
    name: 'depth limit: a proof deeper than limit.maxDepth is refused with model_error, one within it grants',
    // d9#viewer -> g1#member (1) -> g2#member (2) -> g3#member (3): carol, in g3, sits one hop past maxDepth 2.
    world: world([t(d9, 'viewer', members('group', 'g1')), t(ref('group', 'g1'), 'member', members('group', 'g2')), t(ref('group', 'g2'), 'member', members('group', 'g3')), t(ref('group', 'g2'), 'member', u('dave')), t(ref('group', 'g3'), 'member', u('carol'))], { maxDepth: 2 }),
    steps: [check('dave', 'doc:read', d9, ALLOWED), check('carol', 'doc:read', d9, MODEL_ERROR)],
  },
];

export const B49 = fixture('B49', [
  {
    name: 'rebac',
    facets: ['engine', 'rebac'],
    lanes: [],
    note: "Run by @spinajs/authz-rebac's harness (ARCH-7): the real RebacModel over `world.rebac.tuples`, configured from `world.config.rebac`.",
    cases,
  },
]);
