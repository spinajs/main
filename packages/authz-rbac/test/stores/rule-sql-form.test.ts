import * as chai from 'chai';
import 'mocha';

import { AuthzAdminFailure, GLOBAL, matchGlob, matchWildcard } from '@spinajs/authz';
import type { AssignmentSubject, Condition } from '@spinajs/authz';

import { fromSqlForm, likeToGlob, toSqlForm } from '../../src/index.js';
import type { LadderDef, SqlFormRule } from '../../src/index.js';
import { CANVAS_LADDERS, CANVAS_RULES, F1, KIT_LADDERS, kitRuleSets, LINK_MEMBERS_ONLY, O1, P1 } from '../support/rules.js';
import type { Rule } from '../support/rules.js';

const expect = chai.expect;

const failure = (fn: () => unknown): AuthzAdminFailure => {
  try {
    fn();
  } catch (e) {
    expect(e).to.be.instanceOf(AuthzAdminFailure);
    return e as AuthzAdminFailure;
  }
  throw new Error('expected an AuthzAdminFailure');
};

/**
 * The oracle: what `fromSqlForm` must rebuild from the columns. Role names become ladder indexes
 * (`subjects.rank` a closed range, "no role" being -1), a rule without `ladder` gets the one ladder
 * of its role-valued maxRole/minRole, a glob ending in `**` and a glob without `*` read back as the
 * same wildcard, and only the SQL part of `reason` survives.
 */
function sqlPart(r: Rule, ladders: readonly LadderDef[]): SqlFormRule {
  const rank = (role: string, ladder?: string) => {
    const l = ladders.find((x) => (ladder === undefined ? x.roles.includes(role) : x.name === ladder))!;
    return l.roles.indexOf(role);
  };
  const resource = (c: Condition): Condition => {
    const { attr, glob } = c as { attr: string; glob?: string };
    if (glob === undefined) return c;
    if (glob.endsWith('**')) return { attr, wildcard: glob.slice(0, -1) };
    if (!glob.includes('*')) return { attr, wildcard: glob };
    return c;
  };

  const roleName = typeof r.maxRole === 'string' ? r.maxRole : typeof r.minRole === 'string' ? r.minRole : undefined;
  const ladder = r.ladder ?? (roleName === undefined ? undefined : ladders.find((x) => x.roles.includes(roleName))!.name);

  const s = r.subjects;
  let rankSel: NonNullable<SqlFormRule['subjects']>['rank'];
  if (s?.rank) {
    let min: number | undefined;
    let max: number | undefined;
    const at = (role: string) => rank(role, s.rank!.ladder);
    if (s.rank.gte !== undefined) min = at(s.rank.gte);
    if (s.rank.eq !== undefined) min = Math.max(min ?? -1, at(s.rank.eq));
    if (s.rank.eq !== undefined) max = at(s.rank.eq);
    if (s.rank.lt !== undefined) max = Math.min(max ?? Infinity, at(s.rank.lt) - 1);
    rankSel = { ladder: s.rank.ladder, at: s.rank.at, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
  }
  const subjects = s ? { ...(s.principalTypes ? { principalTypes: s.principalTypes } : {}), ...(s.refs ? { refs: s.refs } : {}), ...(rankSel ? { rank: rankSel } : {}) } : undefined;

  return {
    id: r.id,
    kind: r.kind,
    scope: r.scope,
    expiresAt: r.expiresAt ?? null,
    ...(r.resourceTypes ? { resourceTypes: r.resourceTypes } : {}),
    ...(subjects && Object.keys(subjects).length > 0 ? { subjects } : {}),
    ...(r.when ? { when: r.when } : {}),
    allow: r.allow ?? [],
    ...(ladder !== undefined ? { ladder } : {}),
    ...(typeof r.maxRole === 'string' ? { maxRank: rank(r.maxRole, r.ladder) } : {}),
    ...(r.maxRole && typeof r.maxRole === 'object' ? { maxRef: r.maxRole.ref } : {}),
    drops: r.maxRole === null,
    stripTags: r.stripTags === true,
    ...(r.assignments ? { assignments: r.assignments } : {}),
    ...(r.permissions ? { permissions: r.permissions } : {}),
    ...(r.resource ? { resource: resource(r.resource) } : {}),
    ...(typeof r.minRole === 'string' ? { minRank: rank(r.minRole, r.ladder) } : {}),
    ...(r.minRole && typeof r.minRole === 'object' ? { minRef: r.minRole.ref } : {}),
    ...(r.at !== undefined ? { at: r.at } : {}),
    ...(r.reason ? { reason: { code: r.reason.code, ...(r.reason.priority !== undefined ? { priority: r.reason.priority } : {}), ...(r.reason.sortKey !== undefined ? { sortKey: r.reason.sortKey } : {}) } } : {}),
  };
}

const roundTrip = (r: Rule, ladders: readonly LadderDef[]) => {
  const form = toSqlForm(r, ladders);
  return fromSqlForm(form.rule, form.subjects);
};

const sortSubjects = (xs: readonly AssignmentSubject[]) => [...xs].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

const expectRoundTrip = (r: Rule, ladders: readonly LadderDef[]) => {
  const back = roundTrip(r, ladders);
  const want = sqlPart(r, ladders);
  expect({ ...back, allow: sortSubjects(back.allow) }, r.id).to.deep.eq({ ...want, allow: sortSubjects(want.allow) });
};

const threshold = (over: Partial<Rule>): Rule => ({ id: 'r1', kind: 'threshold', scope: P1, permissions: ['file:edit'], minRole: 'editor', ...over });

describe('rule SQL form', () => {
  describe('round trip JSON ⇔ columns', () => {
    const sets = kitRuleSets();

    it('reads every rule set of the kit (B44 RULE_SETS)', () => {
      expect(sets.length).to.be.at.least(11);
      expect(sets.flatMap((s) => s.rules).length).to.be.at.least(13);
    });

    for (const set of sets) {
      it(`kit: ${set.name}`, () => {
        for (const r of set.rules) expectRoundTrip(r, set.ladders);
      });
    }

    for (const r of CANVAS_RULES) {
      it(`design §8.5: ${r.id}`, () => {
        expectRoundTrip(r, CANVAS_LADDERS);
      });
    }

    it('design §8.5: link-members-only stays a config rule (its when reads principal.*)', () => {
      const e = failure(() => toSqlForm(LINK_MEMBERS_ONLY, CANVAS_LADDERS));
      expect(e.code).to.eq('rule_not_compilable');
      expect(e.field).to.eq('when');
    });

    it('a glob ending in ** and a glob without * read back as the same wildcard', () => {
      expect(roundTrip(threshold({ resource: { attr: 'resource.name', glob: 'release/**' } }), KIT_LADDERS).resource).to.deep.eq({ attr: 'resource.name', wildcard: 'release/*' });
      expect(roundTrip(threshold({ resource: { attr: 'resource.name', glob: 'main' } }), KIT_LADDERS).resource).to.deep.eq({ attr: 'resource.name', wildcard: 'main' });
      expect(roundTrip(threshold({ resource: { attr: 'resource.name', glob: 'release/*' } }), KIT_LADDERS).resource).to.deep.eq({ attr: 'resource.name', glob: 'release/*' });
    });

    it('keeps expiry, rank ranges with gte, and an empty allow list', () => {
      const expiresAt = new Date('2026-10-05T10:00:00.000Z');
      expectRoundTrip({ id: 'x', kind: 'restrict', scope: P1, allow: [], expiresAt }, KIT_LADDERS);
      expectRoundTrip({ id: 'y', kind: 'cap', scope: P1, ladder: 'project', maxRole: 'viewer', subjects: { rank: { ladder: 'project', at: 'project', gte: 'commenter', lt: 'maintainer' } } }, KIT_LADDERS);
      expectRoundTrip({ id: 'z', kind: 'cap', scope: P1, stripTags: true, subjects: { refs: [{ type: 'user', id: 'bob' }], rank: { ladder: 'org', at: 'org' } } }, KIT_LADDERS);
      expectRoundTrip({ id: 'w', kind: 'threshold', scope: P1, permissions: [], resourceTypes: [], minRole: 'viewer', when: { attr: 'scope.org.policies.tier', lte: 2.5 } }, KIT_LADDERS);
    });

    it('intersects eq with gte and lt in a rank selector, an empty range included', () => {
      const rank = (sel: object) => toSqlForm({ id: 'k', kind: 'cap', scope: P1, stripTags: true, subjects: { rank: { ladder: 'project', at: 'project', ...sel } } }, KIT_LADDERS).rule;
      expect(rank({ gte: 'commenter', eq: 'viewer' })).to.include({ rank_min: 1, rank_max: 0 });
      expect(rank({ gte: 'viewer', eq: 'editor' })).to.include({ rank_min: 2, rank_max: 2 });
      expect(rank({ eq: 'editor', lt: 'editor' })).to.include({ rank_min: 2, rank_max: 1 });
      expect(rank({ gte: 'editor', lt: 'maintainer' })).to.include({ rank_min: 2, rank_max: 2 });
      for (const sel of [
        { gte: 'commenter', eq: 'viewer' },
        { gte: 'viewer', eq: 'editor' },
        { eq: 'editor', lt: 'editor' },
      ]) {
        expectRoundTrip({ id: 'k', kind: 'cap', scope: P1, stripTags: true, subjects: { rank: { ladder: 'project', at: 'project', ...sel } } }, KIT_LADDERS);
      }
    });
  });

  describe('columns', () => {
    const form = (r: Rule, ladders: readonly LadderDef[] = KIT_LADDERS) => toSqlForm(r, ladders);

    it('cap: ladder index, attribute ref, drop, strip, selectors', () => {
      expect(form({ id: 'c1', kind: 'cap', scope: O1, ladder: 'project', maxRole: 'editor' }).rule).to.include({ ladder: 'project', max_rank: 2, max_ref: null, drops: false, strip_tags: false });
      expect(form({ id: 'c2', kind: 'cap', scope: O1, ladder: 'project', maxRole: { ref: 'scope.org.policies.max_role' } }).rule).to.include({ max_rank: null, max_ref: 'scope.org.policies.max_role', drops: false });
      expect(form({ id: 'c3', kind: 'cap', scope: O1, ladder: 'project', maxRole: null }).rule).to.include({ max_rank: null, max_ref: null, drops: true });
      expect(form({ id: 'c4', kind: 'cap', scope: O1, stripTags: true, assignments: { scopeTypes: ['file', 'project'], subjectTypes: ['link'] } }).rule).to.include({ ladder: null, strip_tags: true, scope_types: ',file,project,', subject_types: ',link,' });

      const ext = form(CANVAS_RULES.find((r) => r.id === 'external-sharing-off')!, CANVAS_LADDERS).rule;
      expect(ext).to.include({ principal_types: ',user,', subject_types: ',user,group,', rank_ladder: 'org', rank_at: 'org', rank_min: null, rank_max: 0, drops: true });
      expect(ext).to.include({ when_path: 'scope.org.policies.external_sharing', when_op: 'eq', when_value: 'false' });

      expect(form(CANVAS_RULES.find((r) => r.id === 'guest-cap')!, CANVAS_LADDERS).rule).to.include({ rank_min: 1, rank_max: 1, max_rank: 2 });
    });

    it('threshold: permissions list, rank of the role in its own ladder, ladder at a type, reason', () => {
      const t = form({ id: 't1', kind: 'threshold', scope: P1, permissions: ['*'], ladder: 'org', at: 'org', minRole: 'org.member', reason: { code: 'members_only' } }).rule;
      expect(t).to.include({ kind: 'threshold', permissions: ',*,', ladder: 'org', at_type: 'org', min_rank: 1, min_ref: null, reason_code: 'members_only', priority: null, sort_key: null });

      const b = form(CANVAS_RULES.find((r) => r.id === 'branch:p1:release/*:merge')!, CANVAS_LADDERS).rule;
      expect(b).to.include({ ladder: 'project', min_rank: 3, resource_types: ',branch,', resource_field: 'name', resource_like: 'release/%', resource_not_like: null, resource_glob: 'release/*', resource_not_glob: null, reason_code: 'branch_protected', priority: 700, sort_key: 'release/*' });

      expect(form(threshold({ minRole: { ref: 'scope.org.policies.min_role' } })).rule).to.include({ ladder: null, min_rank: null, min_ref: 'scope.org.policies.min_role' });
      expect(form(threshold({ minRole: 'org.member' })).rule).to.include({ ladder: 'org', min_rank: 1 });
      expect(form({ id: 'c', kind: 'cap', scope: P1, maxRole: 'commenter' }).rule).to.include({ ladder: 'project', max_rank: 1 });
    });

    it('a glob with one trailing * keeps it inside one path segment (resource_not_like, resource_not_glob)', () => {
      expect(form(threshold({ resource: { attr: 'resource.name', glob: 'release/*' } })).rule).to.include({ resource_like: 'release/%', resource_not_like: 'release/%/%', resource_glob: 'release/*', resource_not_glob: 'release/*/*' });
      expect(form(threshold({ resource: { attr: 'resource.name', glob: 'release/**' } })).rule).to.include({ resource_like: 'release/%', resource_not_like: null, resource_glob: 'release/*', resource_not_glob: null });
      expect(form(threshold({ resource: { attr: 'resource.path', glob: '*' } })).rule).to.include({ resource_field: 'path', resource_like: '%', resource_not_like: '%/%', resource_glob: '*', resource_not_glob: '*/*' });
    });

    it('escapes %, _ and \\ in LIKE patterns and turns * into %', () => {
      const r = threshold({ resource: { attr: 'resource.name', wildcard: 'a%b_c\\d*' } });
      expect(form(r).rule.resource_like).to.eq('a\\%b\\_c\\\\d%');
      expect(roundTrip(r, KIT_LADDERS).resource).to.deep.eq({ attr: 'resource.name', wildcard: 'a%b_c\\d*' });

      const g = threshold({ resource: { attr: 'resource.name', glob: '50%_off\\*' } });
      expect(form(g).rule).to.include({ resource_like: '50\\%\\_off\\\\%', resource_not_like: '50\\%\\_off\\\\%/%', resource_glob: '50%_off\\*', resource_not_glob: '50%_off\\*/*' });
      expect(form(threshold({ resource: { attr: 'resource.name', wildcard: '[x]?*' } })).rule).to.include({ resource_like: '[x]?%', resource_glob: '[[]x][?]*' });
      expect(failure(() => form(threshold({ resource: { attr: 'resource.name', wildcard: '['.repeat(200) + '*' } }))).field).to.eq('resource');
      expect(() => fromSqlForm({ ...form(g).rule, resource_glob: '50%_OFF\\*' }, [])).to.throw(/resource_glob/);
      expect(roundTrip(g, KIT_LADDERS).resource).to.deep.eq({ attr: 'resource.name', glob: '50%_off\\*' });
    });

    it('when: one scope-attribute comparison, the value as JSON', () => {
      expect(form(threshold({ when: { attr: 'scope.org.policies.max', gte: 3 } })).rule).to.include({ when_path: 'scope.org.policies.max', when_op: 'gte', when_value: '3' });
      expect(form(threshold({ when: { attr: 'scope.org.policies.role', ne: 'viewer' } })).rule).to.include({ when_op: 'ne', when_value: '"viewer"' });
      expect(form(threshold({ when: { attr: 'scope.org.policies.tier', eq: 'say "hi"\\' } })).rule).to.include({ when_op: 'eq', when_value: '"say \\"hi\\"\\\\"' });
      expect(form(threshold({ when: { attr: 'scope.org.policies.open', ne: false } })).rule).to.include({ when_op: 'ne', when_value: 'false' });
      expect(form(threshold({ when: { attr: 'scope.org.policies.max', eq: -0.5 } })).rule).to.include({ when_op: 'eq', when_value: '-0.5' });
      expect(form(threshold({ when: { attr: 'scope.org.policies.max', lt: 99999999999999.5 } })).rule).to.include({ when_op: 'lt', when_value: '99999999999999.5' });
      expect(form(threshold({ when: { attr: 'scope.org.policies.tier', null: false } })).rule).to.include({ when_op: 'null', when_value: 'false' });
      expect(form(threshold({ when: { attr: 'scope.org.policies.tier', null: true } })).rule).to.include({ when_op: 'null', when_value: 'true' });
    });

    it('restrict allow and subjects.refs become authz_rule_subject rows, deduplicated', () => {
      const f = form({
        id: 'r',
        kind: 'restrict',
        scope: F1,
        allow: [{ type: 'user', id: 'u1' }, { set: { role: 'group.member', scope: { type: 'group', id: 'g1' } } }, { type: 'user', id: 'u1' }, { set: { role: 'org.member', scope: GLOBAL } }],
        subjects: { refs: [{ type: 'service', id: 's1' }] },
      });
      expect(f.subjects).to.deep.eq([
        { rule_id: 'r', list: 'allow', subject_type: '$global', subject_id: '', subject_role: 'org.member' },
        { rule_id: 'r', list: 'allow', subject_type: 'group', subject_id: 'g1', subject_role: 'group.member' },
        { rule_id: 'r', list: 'allow', subject_type: 'user', subject_id: 'u1', subject_role: '' },
        { rule_id: 'r', list: 'refs', subject_type: 'service', subject_id: 's1', subject_role: '' },
      ]);
      expect(f.rule).to.include({ id: 'r', kind: 'restrict', scope_type: 'file', scope_id: 'f1' });
    });

    it('scope GLOBAL is ($global, ""); every SQL column is null or false when unused', () => {
      const r = form({ id: 'g', kind: 'restrict', scope: GLOBAL }).rule;
      expect(r).to.deep.eq({
        id: 'g',
        kind: 'restrict',
        scope_type: '$global',
        scope_id: '',
        definition: '{"kind":"restrict"}',
        ladder: null,
        max_rank: null,
        max_ref: null,
        drops: false,
        strip_tags: false,
        min_rank: null,
        min_ref: null,
        at_type: null,
        permissions: null,
        resource_types: null,
        subject_types: null,
        scope_types: null,
        principal_types: null,
        rank_ladder: null,
        rank_at: null,
        rank_min: null,
        rank_max: null,
        resource_field: null,
        resource_like: null,
        resource_not_like: null,
        resource_glob: null,
        resource_not_glob: null,
        when_path: null,
        when_op: null,
        when_value: null,
        reason_code: null,
        priority: null,
        sort_key: null,
        expires_at: null,
      });
    });

    it('definition is the rule as JSON without id, scope, expiry and source', () => {
      const expiresAt = new Date('2026-10-05T10:00:00.000Z');
      const r = CANVAS_RULES.find((x) => x.id === 'branch:p1:release/*:push')!;
      const f = form({ ...r, expiresAt, source: 'ignored' } as Rule, CANVAS_LADDERS);
      const { id: _id, scope: _scope, ...rest } = r;
      expect(JSON.parse(f.rule.definition)).to.deep.eq(rest);
      expect(f.rule.expires_at).to.eq(expiresAt);
    });

    it('reads driver values: 0/1 booleans, numeric text, datetime text', () => {
      const f = form({ id: 'd', kind: 'cap', scope: O1, ladder: 'project', maxRole: 'editor', stripTags: true });
      const back = fromSqlForm({ ...f.rule, drops: 0, strip_tags: 1, max_rank: '2', expires_at: '2026-10-05 12:00:00.000' }, []);
      expect(back).to.include({ drops: false, stripTags: true, maxRank: 2 });
      expect(back.expiresAt).to.be.instanceOf(Date);
    });
  });

  describe('likeToGlob (SQLite)', () => {
    it('turns the LIKE text into a case-sensitive GLOB', () => {
      expect(likeToGlob('release/%')).to.eq('release/*');
      expect(likeToGlob('a\\%b\\_c\\\\d%')).to.eq('a%b_c\\d*');
      expect(likeToGlob('x_y')).to.eq('x?y');
      expect(likeToGlob('[a]*?^]')).to.eq('[[]a][*][?]^]');
      expect(() => likeToGlob('bad\\')).to.throw(/trailing/);
    });

    const SAMPLES = ['', 'release', 'release/', 'release/1', 'Release/1', 'RELEASE/1', 'release/1/hotfix', 'releasex', 'a%b_c\\dz', 'a%b_c\\d', 'aXbYc\\d', 'a%bYc\\d', '50%_off\\', '50%_off\\/x', '50X_off\\', 'x[a]*?^]y', '[a]*?^]', 'main', 'ma', 'é/ü', 'ÉÜ', '😀/x'];
    const PATTERNS: { op: 'wildcard' | 'glob'; pattern: string }[] = [
      { op: 'wildcard', pattern: 'release/*' },
      { op: 'wildcard', pattern: 'a%b_c\\d*' },
      { op: 'wildcard', pattern: '*[a]*?^]*' },
      { op: 'wildcard', pattern: 'main' },
      { op: 'wildcard', pattern: 'é/*' },
      { op: 'glob', pattern: 'release/*' },
      { op: 'glob', pattern: 'release/**' },
      { op: 'glob', pattern: '50%_off\\*' },
      { op: 'glob', pattern: '[a]*' },
      { op: 'glob', pattern: '*' },
    ];

    /** SQLite's GLOB for the forms likeToGlob writes (`*`, `?`, `[c]`, literals), over code points; db-rule-store.test runs the real one. */
    const sqliteGlob = (glob: string, text: string): boolean => {
      const tokens: string[] = [];
      const g = [...glob];
      for (let i = 0; i < g.length; i++) {
        if (g[i] === '*') tokens.push('\u0000RUN');
        else if (g[i] === '?') tokens.push('\u0000ONE');
        else if (g[i] === '[') {
          expect(g[i + 2]).to.eq(']');
          tokens.push(g[i + 1]);
          i += 2;
        } else tokens.push(g[i]);
      }
      const t = [...text];
      const go = (ti: number, xi: number): boolean => {
        if (ti === tokens.length) return xi === t.length;
        const tok = tokens[ti];
        if (tok === '\u0000RUN') return go(ti + 1, xi) || (xi < t.length && go(ti, xi + 1));
        if (xi >= t.length) return false;
        return (tok === '\u0000ONE' || tok === t[xi]) && go(ti + 1, xi + 1);
      };
      return go(0, 0);
    };

    it('matches what the core matcher matches, case included', () => {
      for (const { op, pattern } of PATTERNS) {
        const form = toSqlForm(threshold({ resource: { attr: 'resource.name', [op]: pattern } }), KIT_LADDERS).rule;
        const glob = form.resource_glob!;
        const notGlob = form.resource_not_glob;
        expect(glob).to.eq(likeToGlob(form.resource_like!));
        expect(notGlob).to.eq(form.resource_not_like === null ? null : likeToGlob(form.resource_not_like));
        for (const text of SAMPLES) {
          const core = op === 'glob' ? matchGlob(pattern, text) : matchWildcard(pattern, text);
          const sql = sqliteGlob(glob, text) && (notGlob === null || !sqliteGlob(notGlob, text));
          expect(sql, `${op} ${pattern} on ${JSON.stringify(text)} (GLOB ${glob}${notGlob ? ` NOT ${notGlob}` : ''})`).to.eq(core);
        }
      }
    });
  });

  describe('refusals', () => {
    const refuses = (r: Rule, code: string, field: string, ladders: readonly LadderDef[] = KIT_LADDERS) => {
      const e = failure(() => toSqlForm(r, ladders));
      expect({ code: e.code, field: e.field }, `${r.id}: ${e.message}`).to.deep.eq({ code, field });
      expect(e.message).to.match(new RegExp(r.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    };

    it('B44: a glob beyond a fixed prefix and one trailing * (resource)', () => {
      refuses({ id: 'glob', kind: 'threshold', scope: P1, permissions: ['file:edit'], resource: { attr: 'resource.name', glob: 'a*b*' }, minRole: 'maintainer' }, 'rule_not_compilable', 'resource');
    });

    it('B44: more than one scope-attribute comparison in when', () => {
      refuses(
        {
          id: 'two-attrs',
          kind: 'threshold',
          scope: O1,
          permissions: ['file:edit'],
          minRole: 'maintainer',
          when: {
            all: [
              { attr: 'scope.org.policies.locked', eq: true },
              { attr: 'scope.org.policies.max_role', eq: 'viewer' },
            ],
          },
        },
        'rule_not_compilable',
        'when',
      );
    });

    it('B44: the same rules in SQL form are accepted', () => {
      expect(() => toSqlForm({ id: 'prefix', kind: 'threshold', scope: P1, permissions: ['file:edit'], resource: { attr: 'resource.name', glob: 'release/*' }, minRole: 'maintainer' }, KIT_LADDERS)).to.not.throw();
      expect(() => toSqlForm({ id: 'one-attr', kind: 'threshold', scope: O1, permissions: ['file:edit'], minRole: 'maintainer', when: { attr: 'scope.org.policies.locked', eq: true } }, KIT_LADDERS)).to.not.throw();
    });

    it('B43: unknown ladder, unknown role, glob; a wildcard is accepted', () => {
      const ladders: LadderDef[] = [{ name: 'project', roles: ['viewer', 'editor'] }];
      refuses(threshold({ ladder: 'ghost', at: 'project' }), 'unknown_ladder', 'ladder', ladders);
      refuses(threshold({ ladder: 'project', at: 'project', minRole: 'ghost' }), 'unknown_role', 'minRole', ladders);
      refuses(threshold({ resource: { attr: 'resource.name', glob: 'a*b*' } }), 'rule_not_compilable', 'resource', ladders);
      expect(() => toSqlForm(threshold({ resource: { attr: 'resource.name', wildcard: 'release/*' } }), ladders)).to.not.throw();
    });

    it('a cap or threshold whose ladder cannot be resolved', () => {
      refuses(threshold({ minRole: 'ghost' }), 'rule_not_compilable', 'ladder');
      refuses({ id: 'c', kind: 'cap', scope: P1, maxRole: 'ghost' }, 'rule_not_compilable', 'ladder');
      refuses({ id: 'c', kind: 'cap', scope: P1, maxRole: null }, 'rule_not_compilable', 'ladder');
      refuses({ id: 'c', kind: 'cap', scope: P1, maxRole: { ref: 'scope.org.policies.max_role' } }, 'rule_not_compilable', 'ladder');
      const twice: LadderDef[] = [...KIT_LADDERS, { name: 'other', roles: ['viewer'] }];
      refuses(threshold({ minRole: 'viewer' }), 'rule_not_compilable', 'ladder', twice);
      refuses({ id: 'c', kind: 'cap', scope: P1, maxRole: 'viewer' }, 'rule_not_compilable', 'ladder', twice);
      expect(toSqlForm({ id: 'c', kind: 'cap', scope: P1, ladder: 'other', maxRole: 'viewer' }, twice).rule).to.include({ ladder: 'other', max_rank: 0 });
      expect(toSqlForm({ id: 'c', kind: 'cap', scope: P1, stripTags: true }, twice).rule).to.include({ ladder: null });
    });

    it('permission globs other than * itself', () => {
      refuses(threshold({ permissions: ['file:*'] }), 'rule_not_compilable', 'permissions');
      refuses(threshold({ permissions: ['file:edit', 'f*:ed*'] }), 'rule_not_compilable', 'permissions');
      refuses(threshold({ permissions: ['**'] }), 'rule_not_compilable', 'permissions');
      expect(toSqlForm(threshold({ permissions: ['*', 'file:edit'] }), KIT_LADDERS).rule.permissions).to.eq(',*,file:edit,');
    });

    it('when: comparisons whose SQL could differ from the core coercion', () => {
      for (const when of [
        { attr: 'scope.org.policies.tier', in: ['a', 'b'] },
        { attr: 'scope.org.policies.tier', nin: [1] },
        { attr: 'scope.org.policies.tier', eq: '3' },
        { attr: 'scope.org.policies.tier', ne: '-2.5' },
        { attr: 'scope.org.policies.tier', lt: 'm' },
        { attr: 'scope.org.policies.tier', gte: '3' },
        { attr: 'scope.org.policies.max', gt: 1e14 },
        { attr: 'scope.org.policies.max', lte: 0.1234567 },
      ]) {
        refuses(threshold({ when }), 'rule_not_compilable', 'when');
      }
      for (const when of [
        { attr: 'scope.org.policies.tier', eq: '3a' },
        { attr: 'scope.org.policies.tier', eq: '03' },
        { attr: 'scope.org.policies.max', eq: 1e20 },
        { attr: 'scope.org.policies.max', gte: -99999999999999.99 },
      ]) {
        expect(() => toSqlForm(threshold({ when }), KIT_LADDERS), JSON.stringify(when)).to.not.throw();
      }
    });

    it('unknown ladder or role where a rank is computed', () => {
      refuses({ id: 'c', kind: 'cap', scope: P1, ladder: 'project', maxRole: 'org.member' }, 'unknown_role', 'maxRole');
      refuses({ id: 'c', kind: 'cap', scope: P1, ladder: 'ghost', maxRole: 'viewer' }, 'unknown_ladder', 'ladder');
      refuses({ id: 'c', kind: 'cap', scope: P1, stripTags: true, subjects: { rank: { ladder: 'ghost', at: 'org', lt: 'org.member' } } }, 'unknown_ladder', 'subjects.rank.ladder');
      refuses({ id: 'c', kind: 'cap', scope: P1, stripTags: true, subjects: { rank: { ladder: 'org', at: 'org', gte: 'viewer' } } }, 'unknown_role', 'subjects.rank.gte');
    });

    it('when: anything but one comparison of a scope attribute with a literal', () => {
      refuses(threshold({ when: { attr: 'principal.attributes.contractor', eq: true } }), 'rule_not_compilable', 'when');
      refuses(threshold({ when: { attr: 'resource.status', eq: 'x' } }), 'rule_not_compilable', 'when');
      refuses(threshold({ when: { attr: 'scope.org.policies.max', eq: { ref: 'principal.attributes.max' } } }), 'rule_not_compilable', 'when');
      refuses(threshold({ when: { not: { attr: 'scope.org.policies.locked', eq: true } } }), 'rule_not_compilable', 'when');
      refuses(threshold({ when: { all: [{ attr: 'scope.org.policies.locked', eq: true }] } }), 'rule_not_compilable', 'when');
      refuses(threshold({ when: { attr: 'scope.org.policies.name', like: 'a%' } }), 'rule_not_compilable', 'when');
      refuses(threshold({ when: { fn: 'time.between', args: {} } }), 'rule_not_compilable', 'when');
      refuses(threshold({ when: { attr: 'scope.org.policies.x', bogus: 1 } }), 'rule_not_compilable', 'when');
      refuses(threshold({ when: { attr: 'scope.org.policies.x', eq: 'v'.repeat(300) } }), 'rule_not_compilable', 'when');
    });

    it('resource: a wildcard or prefix glob on one column of the resource', () => {
      refuses(threshold({ resource: { attr: 'resource.name', eq: 'main' } }), 'rule_not_compilable', 'resource');
      refuses(threshold({ resource: { attr: 'resource.name', like: 'rel%' } }), 'rule_not_compilable', 'resource');
      refuses(threshold({ resource: { attr: 'resource.meta.name', wildcard: 'a*' } }), 'rule_not_compilable', 'resource');
      refuses(threshold({ resource: { attr: 'scope.org.name', wildcard: 'a*' } }), 'rule_not_compilable', 'resource');
      refuses(threshold({ resource: { attr: 'resource.name', glob: 'a/*/b' } }), 'rule_not_compilable', 'resource');
      refuses(threshold({ resource: { attr: 'resource.name', glob: '***' } }), 'rule_not_compilable', 'resource');
      refuses(threshold({ resource: { attr: 'resource.name', wildcard: { ref: 'principal.attributes.prefix' } } as Condition }), 'rule_not_compilable', 'resource');
      refuses(threshold({ resource: { any: [{ attr: 'resource.name', wildcard: 'a*' }] } }), 'rule_not_compilable', 'resource');
    });

    it('selectors SQL cannot hold: actorTypes, subjects.when, an empty refs list', () => {
      refuses(threshold({ subjects: { actorTypes: ['agent'] } }), 'rule_not_compilable', 'subjects.actorTypes');
      refuses(threshold({ subjects: { when: { attr: 'principal.attributes.contractor', eq: true } } }), 'rule_not_compilable', 'subjects.when');
      refuses(threshold({ subjects: { refs: [] } }), 'rule_not_compilable', 'subjects.refs');
    });

    it('maxRole and minRole refs read a scope attribute', () => {
      refuses({ id: 'c', kind: 'cap', scope: P1, ladder: 'project', maxRole: { ref: 'principal.attributes.max' } }, 'rule_not_compilable', 'maxRole');
      refuses(threshold({ minRole: { ref: 'env.min' } }), 'rule_not_compilable', 'minRole');
      refuses(threshold({ minRole: { ref: 'scope.org' } }), 'rule_not_compilable', 'minRole');
    });

    it('lists, lengths, kind, reason and expiry that the columns cannot hold', () => {
      refuses(threshold({ permissions: ['file:edit,file:read'] }), 'rule_not_compilable', 'permissions');
      refuses(threshold({ permissions: ['x'.repeat(1100)] }), 'rule_not_compilable', 'permissions');
      refuses(threshold({ resourceTypes: [''] }), 'rule_not_compilable', 'resourceTypes');
      refuses({ id: 'c', kind: 'cap', scope: P1, stripTags: true, assignments: { scopeTypes: ['a,b'] } }, 'rule_not_compilable', 'assignments.scopeTypes');
      refuses({ id: 'c', kind: 'cap', scope: P1, stripTags: true, subjects: { principalTypes: ['a,b'] } }, 'rule_not_compilable', 'subjects.principalTypes');
      refuses(threshold({ id: 'i'.repeat(161) }), 'rule_not_compilable', 'id');
      refuses(threshold({ scope: { type: 'project', id: 'p'.repeat(65) } }), 'rule_not_compilable', 'scope');
      refuses({ ...threshold({}), kind: 'deny' as Rule['kind'] }, 'rule_not_compilable', 'kind');
      refuses(threshold({ reason: { code: 'policy', priority: 1.5 } }), 'rule_not_compilable', 'reason.priority');
      refuses(threshold({ reason: { code: '' } }), 'rule_not_compilable', 'reason.code');
      refuses(threshold({ expiresAt: new Date('nope') }), 'rule_not_compilable', 'expiresAt');
      refuses({ id: 'r', kind: 'restrict', scope: P1, allow: [{ set: { role: '', scope: O1 } }] }, 'rule_not_compilable', 'allow');
      refuses({ id: 'r', kind: 'restrict', scope: P1, allow: [{ type: 'user', id: 'u'.repeat(65) }] }, 'rule_not_compilable', 'allow');
    });
  });
});
