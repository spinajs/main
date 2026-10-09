import { GLOBAL } from '@spinajs/authz';
import type { Principal, RuleDef, ScopeAttributeSchema } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';

import { RbacRoleGraphSource, RbacScopeAttributeSource } from '../../src/orm/index.js';
import { KINDS, RootOrm } from '../orm/root-orm.js';
import { RouteWorld, assignment, at, registerRouteSources, u, user } from './route-world.js';

/*
 * The config rules' scope leaves (compile/rules.ts `scopeLeaf`, `equals`) against the engine's `cmp` and `coerce`,
 * attribute kind by literal kind: numbers (short, long, with an exponent), strings (numeric or not, spelled with
 * escapes), booleans, null, a list and an object, against number, string and boolean literals under eq, ne,
 * in, nin, the order ops and a pattern. Each leaf A sits in a threshold (`when: A`, doc:edit), in its negation
 * (`when: { not: A }`, doc:comment) and in restricts at o1 and o2 (bob), so the listings give A's three-valued
 * truth at docs 1 and 3 (o1) and 2 and 4 (o2), from check() and from SQL. SQL must give the check's truth; UNKNOWN
 * instead of a decided truth only where compile/rules.ts documents it (a string attribute against a number, under
 * an order op or a pattern, or spelled with an escape; a number text longer than SQL compares). Every list:
 * listed ⊆ check().
 */

type Rule = Omit<RuleDef, 'source'>;
type When = NonNullable<RuleDef['when']>;
type Truth = 'true' | 'false' | 'unknown';

const O = (id: string) => at('org', id);
const V = 'scope.org.policies.v';
const SCHEMAS: readonly ScopeAttributeSchema[] = [{ scopeType: 'org', schema: {}, defaults: {} }];
// The docs under o1 and o2: 1 p10/o1, 2 p10/o2, 3 p11/o1, 4 -/o2.
const DOCS = ['1', '2', '3', '4'];

// JSON texts of `policies.v` at o1 and o2, two per scenario; a group is one test, short enough for a busy Postgres.
const VALUES: readonly (readonly [string, readonly (readonly [string, string])[]])[] = [
  [
    'numbers',
    [
      ['0', '1'],
      ['3', '-2.5'],
    ],
  ],
  [
    'numbers spelled otherwise (1.0, 1e0, 17 digits) and null',
    [
      ['1.0', '1e0'],
      ['3.0000000000000001', 'null'],
    ],
  ],
  [
    'strings, numeric or not',
    [
      ['"3"', '"03"'],
      ['"1"', '"abc"'],
    ],
  ],
  [
    'strings: empty, negative, spelled with escapes',
    [
      ['""', '"-1"'],
      ['"\\u0033"', '"\\"q"'],
    ],
  ],
  [
    'booleans, a list and an object',
    [
      ['true', 'false'],
      ['[1]', '{"a":1}'],
    ],
  ],
];

const LEAVES: readonly When[] = [...[3, 1, 0, '3', '1', 'abc', true, false].map((eq) => ({ attr: V, eq })), ...[3, '1', 'abc', true, false].map((ne) => ({ attr: V, ne })), { attr: V, in: [3, 'abc'] }, { attr: V, in: ['1', 0] }, { attr: V, nin: [1, 'x'] }, ...[2, '2', 'b'].map((lt) => ({ attr: V, lt })), ...[1, '-1'].map((lte) => ({ attr: V, lte })), { attr: V, gt: '0' }, ...[1, '10', 'a'].map((gte) => ({ attr: V, gte })), { attr: V, wildcard: '1*' }] as When[];

const ORDER_OPS = new Set(['lt', 'lte', 'gt', 'gte']);

/** compile/rules.ts may answer UNKNOWN where the engine decides: documented there, narrower in every rule kind. */
function mayBeUndecided(json: string, leaf: When): boolean {
  const v: unknown = JSON.parse(json);
  const [op, lit] = Object.entries(leaf).find(([k]) => k !== 'attr')!;
  const literals: unknown[] = Array.isArray(lit) ? lit : [lit];
  if (typeof v === 'number') return json.length > 15 || /e/i.test(json);
  if (typeof v === 'string') return ORDER_OPS.has(op) || op === 'wildcard' || literals.some((l) => typeof l === 'number') || json.includes('\\');
  return false;
}

describe('authz-rbac orm-compile: config scope leaves in SQL = the engine, value kind by literal kind', function () {
  this.timeout(1800000);

  let db: RootOrm;
  let undoSources: (() => void) | undefined;

  before(async function () {
    db = await RootOrm.open(this, 'l4b_when_leaves');
    await (await testHost.domains()).service('root');
    undoSources = registerRouteSources();
  });

  after(async () => {
    undoSources?.();
    DI.uncache(RbacRoleGraphSource);
    DI.uncache(RbacScopeAttributeSource);
    await db?.close();
  });

  for (const kind of KINDS) {
    describe(kind, () => {
      let world: RouteWorld;

      before(async () => {
        world = await RouteWorld.open(db, kind);
      });

      after(async () => {
        await world?.close();
      });

      const by = (id: string) => ({ refs: [{ type: 'user' as const, id }] });
      // Leaf a: ann's doc:edit and doc:comment, bob; leaf b: ann's doc:read and doc:audit, cid.
      const rulesOf = (a: When, b: When): Rule[] => [
        { id: 'ta', kind: 'threshold', scope: GLOBAL, permissions: ['doc:edit'], minRole: 'maintainer', subjects: by('ann'), when: a },
        { id: 'tna', kind: 'threshold', scope: GLOBAL, permissions: ['doc:comment'], minRole: 'maintainer', subjects: by('ann'), when: { not: a } },
        { id: 'tb', kind: 'threshold', scope: GLOBAL, permissions: ['doc:read'], minRole: 'maintainer', subjects: by('ann'), when: b },
        { id: 'tnb', kind: 'threshold', scope: GLOBAL, permissions: ['doc:audit'], minRole: 'maintainer', subjects: by('ann'), when: { not: b } },
        ...['o1', 'o2'].flatMap((o): Rule[] => [
          { id: `ra-${o}`, kind: 'restrict', scope: O(o), allow: [], subjects: by('bob'), when: a },
          { id: `rb-${o}`, kind: 'restrict', scope: O(o), allow: [], subjects: by('cid'), when: b },
        ]),
      ];
      const rows = ['ann', 'bob', 'cid'].map((id) => assignment(u(id), 'editor', GLOBAL));
      const setValue = (scopeId: string, json: string) => db.raw(kind, `UPDATE "authz_scope_attribute" SET "value_json" = ? WHERE "scope_type" = 'org' AND "scope_id" = ? AND "path" = 'policies.v'`, [json, scopeId]);

      /** check() on docs 1-4, and what SQL lists of them, which must be among them. */
      async function lists(p: Principal, permission: string, why: string): Promise<{ allowed: string[]; listed: string[] }> {
        const allowed: string[] = [];
        for (const id of DOCS) {
          if ((await world.service.check({ principal: p, permission, resource: { type: 'doc', id }, subject: await world.row(id) })).allowed) allowed.push(id);
        }
        const listed = (await world.listed(p, permission)).filter((d) => DOCS.includes(d));
        expect(
          listed.filter((d) => !allowed.includes(d)),
          `listed but refused by check(): ${p.id} ${permission}, ${why}`,
        ).to.deep.equal([]);
        return { allowed, listed };
      }

      const truth = (no: readonly string[], yes: readonly string[] | undefined, doc: string): Truth => (no.includes(doc) ? 'false' : yes === undefined ? 'unknown' : yes.includes(doc) ? 'true' : 'unknown');

      async function table(values: readonly (readonly [string, string])[]): Promise<void> {
        const counts = { true: 0, false: 0, unknown: 0, undecided: 0 };
        const started = Date.now();
        for (const [v1, v2] of values) {
          for (let i = 0; i < LEAVES.length; i += 2) {
            const [a, b] = [LEAVES[i], LEAVES[i + 1]];
            await world.configure({ rules: rulesOf(a, b), schemas: SCHEMAS, attributes: [O('o1'), O('o2')].map((o) => [o, { policies: { v: 0 } }] as const) });
            await setValue('o1', v1);
            await setValue('o2', v2);
            await world.assign(rows);
            for (const [leaf, no, yes, restricted] of [
              [a, 'doc:edit', 'doc:comment', 'bob'],
              [b, 'doc:read', 'doc:audit', 'cid'],
            ] as const) {
              const why = `${kind}, o1 ${v1}, o2 ${v2}, ${JSON.stringify(leaf)}`;
              const tNo = await lists(user('ann'), no, why);
              const tYes = await lists(user('ann'), yes, why);
              const r = await lists(user(restricted), 'doc:edit', why);
              for (const doc of DOCS) {
                const json = doc === '1' || doc === '3' ? v1 : v2;
                const at = `${why}: doc ${doc}`;
                const engine = truth(tNo.allowed, tYes.allowed, doc);
                // The restrict drops ann's GLOBAL editor where the leaf is not FALSE.
                expect(truth(r.allowed, undefined, doc) === 'false', `check(): the restrict reads the leaf as the thresholds do, ${at}`).to.equal(engine === 'false');
                const undecided = engine !== 'unknown' && mayBeUndecided(json, leaf);
                const sql = truth(tNo.listed, tYes.listed, doc);
                if (undecided && sql === 'unknown') counts.undecided++;
                else expect(sql, `threshold: ${at}`).to.equal(engine);
                if (!(undecided && !r.listed.includes(doc))) expect(r.listed.includes(doc), `restrict: ${at}`).to.equal(engine === 'false');
                counts[engine]++;
              }
            }
          }
        }
        console.log(`      ${kind}: ${values.length * 2} values x ${LEAVES.length} leaves x ${DOCS.length} docs in ${Date.now() - started} ms; engine ${JSON.stringify(counts)}`);
        expect(counts.true, 'TRUE leaves').to.be.at.least(10);
        expect(counts.false, 'FALSE leaves').to.be.at.least(10);
        expect(counts.unknown, 'UNKNOWN leaves').to.be.at.least(20);
      }

      for (const [name, values] of VALUES) {
        it(`${name}: each leaf is TRUE, FALSE or UNKNOWN in SQL as the engine decides it, in thresholds and restricts`, async () => {
          await table(values);
        });
      }
    });
  }
});
