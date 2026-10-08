import { GLOBAL } from '@spinajs/authz';
import type { RuleDef } from '@spinajs/authz';
import { BEHAVIOUR_FIXTURES, fixtureDsl, runBehaviour, userPrincipal } from '@spinajs/authz-testing';
import type { Case, World } from '@spinajs/authz-testing';
import { expect } from 'chai';
import 'mocha';

import { sqlExpressibleGlob } from '../../src/orm/index.js';
import { KINDS } from '../orm/root-orm.js';
import { sqlKitHarness } from './kit-harness.js';

/*
 * Boot rule §6.5.11 (L4b plan task 7): kit B05.sql on the lane SQL harness, strict, and lane cases beside it for
 * the rule's other shapes (config rules) and the controls that must boot.
 */

const { assignment, combine, extension, ref, role } = fixtureDsl;
const alice = userPrincipal('alice');
const P1 = ref('project', 'p1');

const PERMISSIONS = [
  { name: 'file:read', types: ['file'] },
  { name: 'file:edit', types: ['file'] },
  { name: 'project:read', types: ['project'] },
  // No adapter serves 'note': it lists nowhere in SQL.
  { name: 'note:read', types: ['note'] },
];

function world(grantOn: readonly { type: string; id?: string }[] | undefined, rules: readonly Omit<RuleDef, 'source'>[] = []): World {
  return {
    permissions: PERMISSIONS,
    principals: { alice },
    adapters: [
      {
        types: ['file', 'project'],
        rows: { file: [{ id: 'f1', name: 'a/b' }], project: [{ id: 'p1' }] },
        parents: [[ref('file', 'f1'), P1] as const],
      },
    ],
    combine: combine('deny-overrides', 'rbac'),
    rbac: {
      ladders: [{ name: 'project', roles: ['viewer', 'maintainer'] }],
      roles: [role('viewer', [grantOn ? { permission: 'file:read', on: grantOn.map((p) => ({ ...p })) } : 'file:read', 'file:edit', 'project:read'], { ladder: 'project' }), role('maintainer', [], { ladder: 'project' })],
      assignments: [assignment('a1', alice, 'viewer', P1)],
      rules: rules.map((r) => ({ ...r, source: 'test' })),
    },
  };
}

const refused = (name: string, w: World, message: string[]): Case => ({ name, world: w, boot: { throws: 'AuthzConfigError', message: ['$domain', '6.5 rule 11', ...message] }, steps: [] });
const boots = (name: string, w: World): Case => ({ name, world: w, steps: [{ check: { as: 'alice', permission: 'file:edit', resource: ref('file', 'f1'), subject: 'row' }, expect: { allowed: true } }] });

const threshold = (extra: Partial<RuleDef>): Omit<RuleDef, 'source'> => ({ id: 't1', kind: 'threshold', scope: GLOBAL, permissions: ['file:edit'], minRole: 'maintainer', ...extra } as Omit<RuleDef, 'source'>);

const LOCAL = [
  extension('B05', [
    {
      name: 'sql-l4b',
      facets: ['engine', 'boot', 'rbac', 'rules', 'sql'],
      lanes: ['L4b'],
      note: 'Rule 11 beyond the kit case: config rules, and the shapes SQL can express (controls).',
      cases: [
        boots(
          'control: a prefix glob, a ** glob and a template prefix boot',
          world([
            { type: 'file', id: 'a/*' },
            { type: 'file', id: 'a/**' },
            { type: 'file', id: '{principal.id}/*' },
          ]),
        ),
        refused('a glob with a * before its end', world([{ type: 'file', id: '*/b' }]), ["type 'file'", "rbac role 'viewer' grant 'file:read'", '"*/b"']),
        refused('a config threshold whose resource glob is more than a prefix', world(undefined, [threshold({ resource: { attr: 'resource.name', glob: 'a*b' } })]), ["type 'file'", "rbac rule 't1'", '"a*b"']),
        refused('a config threshold whose when reads a field that is no column', world(undefined, [threshold({ when: { attr: 'resource.size', gt: 3 } })]), ["type 'file'", "rbac rule 't1'", 'resource.size']),
        refused('a config threshold whose resource glob is a ref', world(undefined, [threshold({ resource: { attr: 'resource.name', glob: { ref: 'principal.attributes.home' } } as never })]), ["type 'file'", "rbac rule 't1'", 'not a literal']),
        boots('control: the same rule limited to another type boots', world(undefined, [threshold({ resourceTypes: ['project'], when: { attr: 'resource.size', gt: 3 } })])),
        boots('control: a threshold whose permissions are on a type no SQL lists boots', world(undefined, [threshold({ permissions: ['note:read'], resource: { attr: 'resource.title', glob: 'a*b' } })])),
        boots('control: a prefix glob and a wildcard on a column boot', world(undefined, [threshold({ resource: { attr: 'resource.name', glob: 'z/**' } }), threshold({ id: 't2', when: { attr: 'resource.name', wildcard: '*zz*' } })])),
        // '*' matches project:read too, and projects have no name column.
        refused('a threshold on every permission reading a field one of the types lacks', world(undefined, [threshold({ permissions: ['*'], resource: { attr: 'resource.name', glob: 'z/*' } })]), ["type 'project'", "rbac rule 't1'", 'resource.name']),
        boots('control: a permission glob that matches only the type with the column boots', world(undefined, [threshold({ permissions: ['file:*'], resource: { attr: 'resource.name', glob: 'z/*' } })])),
      ],
    },
  ]),
];

describe('authz-rbac orm-compile: boot rule §6.5.11', () => {
  it('a glob SQL expresses is a fixed prefix and at most one trailing * or **', () => {
    for (const ok of ['a', 'a/*', 'a/**', '*', '**', '']) expect(sqlExpressibleGlob(ok), ok).to.equal(true);
    for (const no of ['a*b*', '*/b', 'a/*/c', 'a/***', '**/x', 'a**b']) expect(sqlExpressibleGlob(no), no).to.equal(false);
  });

  for (const kind of KINDS) {
    describe(kind, function () {
      this.timeout(600000);
      runBehaviour(['B05.sql', 'B05.sql-l4b'], () => sqlKitHarness({ kind }), { strict: true, timeoutMs: 120000, fixtures: [...BEHAVIOUR_FIXTURES, ...LOCAL] });
    });
  }
});
