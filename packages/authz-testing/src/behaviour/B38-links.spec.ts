import { GLOBAL } from '@spinajs/authz';

import { userPrincipal } from '../principals.js';
import { assignment, combine, fixture, later, ref, role } from './dsl.js';
import { checks, exec, linkRowsHide, principalIs, requestPrincipal, savedId, tokenOnlyInResult, viaLink, viaSavedLink } from './model-steps.js';
import type { Via } from './model-steps.js';
import type { Case, DecisionExpectation, World, WorldLink } from './types.js';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const HOUR = 3_600_000;
const O1 = ref('org', 'o1');
const P1 = ref('project', 'p1');
const P2 = ref('project', 'p2');
const f1 = ref('file', 'f1');
const f2 = ref('file', 'f2');

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');

const LINKS: WorldLink[] = [
  { id: 'l1', scope: P1, expiresAt: later(NOW, HOUR), attributes: {}, role: 'viewer', token: 'tok-l1' },
  { id: 'l2', scope: P1, expiresAt: later(NOW, -1_000), attributes: {}, role: 'viewer', token: 'tok-l2' },
  { id: 'l3', scope: P1, attributes: {}, role: 'viewer', token: 'tok-l3', revoked: true },
  { id: 'l4', scope: f2, attributes: {}, role: 'viewer', token: 'tok-l4' },
];
const TOKENS = LINKS.map((l) => l.token);

const TYPES = ['org', 'project', 'file'];

const world = (links: readonly WorldLink[] = LINKS): World => ({
  now: NOW,
  permissions: ['file:read', 'file:edit', 'authz:links.manage', 'authz:links.read'].map((name) => ({ name, types: TYPES })),
  principals: { alice, bob },
  scopes: [
    {
      nodes: [
        { ref: P1, parent: O1 },
        { ref: f1, parent: P1 },
        { ref: P2, parent: O1 },
        { ref: f2, parent: P2 },
      ],
    },
  ],
  combine: combine('deny-overrides', 'rbac'),
  rbac: {
    roles: [role('viewer', ['file:read']), role('editor', ['file:read', 'file:edit']), role('link-manager', ['authz:links.manage', 'file:read']), role('link-reader', ['authz:links.read'])],
    assignments: [assignment('a1', alice, 'editor', GLOBAL), assignment('b1', bob, 'link-manager', O1), assignment('b2', bob, 'link-reader', GLOBAL)],
    links,
  },
});

const ALLOWED: DecisionExpectation = { allowed: true };
const LINK_INVALID: DecisionExpectation = { allowed: false, reason: 'link_invalid' };
const read = (resource: typeof f1, expect: DecisionExpectation) => ({ permission: 'file:read', resource, expect });
const edit = (resource: typeof f1, expect: DecisionExpectation) => ({ permission: 'file:edit', resource, expect });

const linkCases: Case[] = [
  {
    name: 'the token resolves to a link principal whose ceiling is the link scope and expiry, reason link_invalid',
    world: world(),
    steps: [principalIs(viaLink('tok-l1'), { type: 'link', id: 'l1', ceiling: { resources: [P1], expiresAt: later(NOW, HOUR), reason: 'link_invalid' } }, 'the principal of tok-l1')],
  },
  {
    name: "the link's assignment grants its role inside the link scope",
    world: world(),
    steps: [checks(viaLink('tok-l1'), [read(f1, ALLOWED), read(P1, ALLOWED), read(f2, LINK_INVALID)]), checks(viaLink('tok-l4'), [read(f2, ALLOWED), read(f1, LINK_INVALID)])],
  },
  { name: 'an expired link denies every check with link_invalid', world: world(), steps: [checks(viaLink('tok-l2'), [read(f1, LINK_INVALID), edit(f1, LINK_INVALID)])] },
  { name: 'a revoked link denies every check with link_invalid', world: world(), steps: [checks(viaLink('tok-l3'), [read(f1, LINK_INVALID), read(f2, LINK_INVALID)])] },
  { name: 'an unknown token denies every check with link_invalid', world: world(), steps: [checks(viaLink('tok-ghost'), [read(f1, LINK_INVALID), read(f2, LINK_INVALID), edit(f1, LINK_INVALID)])] },
  {
    name: "access is the link's assignment and the companion's own, inside the ceiling",
    world: world(),
    steps: [principalIs(viaLink('tok-l1', 'alice'), { type: 'link', id: 'l1', companions: ['alice'] }, 'the principal of tok-l1 carried by alice'), checks(viaLink('tok-l1', 'alice'), [edit(f1, ALLOWED), read(f1, ALLOWED), edit(f2, LINK_INVALID), read(f2, LINK_INVALID)]), checks(viaLink('tok-l1'), [edit(f1, { allowed: false, reason: 'no_access' })], 'without the companion')],
  },
];

const storeCases: Case[] = [...linkCases, { name: 'the stored link rows hold the token only hashed', world: world(), steps: [linkRowsHide(TOKENS)] }];

const createLink = { kind: 'link.create', scope: P1, role: 'viewer', expiresAt: later(NOW, HOUR) } as const;

const adminCases = (via: Via): Case[] => [
  {
    name: 'link.create returns the token once, in the command result, and it resolves to the link',
    world: world([]),
    steps: [exec('bob', [createLink], 'ok', { via, save: 'link' }), checks(viaSavedLink('link'), [read(f1, ALLOWED), read(f2, LINK_INVALID)])],
  },
  { name: 'the token appears in no audit entry, change, event or link listing', world: world([]), steps: [exec('bob', [createLink], 'ok', { via, save: 'link' }), tokenOnlyInResult('link', 0, via, 'bob')] },
  {
    name: 'a revoked link denies link_invalid from then on',
    world: world([]),
    steps: [exec('bob', [createLink], 'ok', { via, save: 'link' }), exec('bob', (s) => [{ kind: 'link.revoke', id: savedId(s, 'link') }], 'ok', { via }), checks(viaSavedLink('link'), [read(f1, LINK_INVALID)])],
  },
];

export const B38 = fixture('B38', [
  {
    name: 'rbac',
    facets: ['engine', 'rbac', 'links'],
    lanes: ['L1b'],
    note: 'The model part over a MemoryLinkStore: world.rbac.links are links with their tokens and assignments; the lane handle rbacLinks resolves a token as LinkPrincipalSource would (design §6.1.6). Expired links are also B14.',
    cases: linkCases,
  },
  { name: 'store', facets: ['engine', 'rbac', 'links', 'store'], lanes: ['L2'], note: 'The same cases on DbLinkStore; rbacStore.linkRows() shows what authz_link holds.', cases: storeCases },
  { name: 'admin', facets: ['engine', 'rbac', 'links', 'admin', 'audit', 'bus'], lanes: ['L9', 'C4'], note: 'bob holds authz:links.manage and file:read at o1, so he covers the viewer role his links grant (the guard of B26), and authz:links.read at GLOBAL to list links.', cases: adminCases('admin') },
  { name: 'adminHttp', facets: ['http', 'engine', 'rbac', 'links'], lanes: ['C4'], note: 'The admin cases through POST /authz/commands and GET /authz/links (lane handle adminHttp).', cases: adminCases('http') },
  {
    name: 'http',
    facets: ['http', 'links'],
    lanes: ['L5'],
    note: "LinkPrincipalSource (order 110) with the default authz.http.links = { query: 'link', header: 'X-Authz-Link', cookie: null } (design §8.1); lane handle linkSource.",
    world: world(),
    cases: [
      { name: 'a token in the link query parameter yields the link principal', steps: [requestPrincipal({ token: 'tok-l1', in: 'query' }, { type: 'link', id: 'l1' })] },
      { name: 'a token in the X-Authz-Link header yields the link principal', steps: [requestPrincipal({ token: 'tok-l1', in: 'header' }, { type: 'link', id: 'l1' })] },
      { name: 'the cookie is not read while authz.http.links.cookie is null', steps: [requestPrincipal({ token: 'tok-l1', in: 'cookie' }, 'not a link')] },
      { name: 'the session principal becomes the companion of the link principal it is replaced by', steps: [requestPrincipal({ token: 'tok-l1', in: 'query', session: 'alice' }, { type: 'link', id: 'l1', companions: ['alice'] })] },
    ],
  },
]);
