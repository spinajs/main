import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';

import { selectDenyReason, staticTruths } from '../../src/engine/reasons.js';
import type { ReasonInput, VoteTruths } from '../../src/engine/reasons.js';
import { FALSE, TRUE, compareDenyReasons, or } from '../../src/index.js';
import type { DenyReason, ResourceFilter, Vote } from '../../src/index.js';

const expect = chai.expect;

const RESIDUAL: ResourceFilter = { op: 'cmp', field: 'owner', cmp: 'eq', value: 'alice' };

const vote = (model: string, extra: Partial<Vote> = {}): Vote => ({ model, permitWhen: FALSE, denyWhen: FALSE, cacheable: true, ...extra });
const faulty = (model: string, extra: Partial<Vote> = {}): Vote => ({ model, permitWhen: FALSE, denyWhen: TRUE, cacheable: false, error: 'store down: secret detail', ...extra });
const truths = (permit: boolean | undefined, ...denies: (boolean | undefined)[]): VoteTruths => ({ permit, denies });

const sameData = (a: unknown, b: unknown): boolean => {
  try {
    expect(a).to.deep.equal(b);
    return true;
  } catch {
    return false;
  }
};

const select = (over: Partial<ReasonInput>): DenyReason => selectDenyReason({ core: [], votes: [], truths: [], algorithm: 'deny-overrides', subjectEvaluated: false, ...over });

describe('staticTruths', () => {
  it('maps TRUE, FALSE and a residual permit to true, false and undefined', () => {
    expect(staticTruths(vote('m', { permitWhen: TRUE })).permit).to.equal(true);
    expect(staticTruths(vote('m', { permitWhen: FALSE })).permit).to.equal(false);
    expect(staticTruths(vote('m', { permitWhen: RESIDUAL })).permit).to.equal(undefined);
  });

  it('simplifies before reading the truth', () => {
    expect(staticTruths(vote('m', { permitWhen: { op: 'and', args: [TRUE, { op: 'not', arg: FALSE }] } })).permit).to.equal(true);
    expect(staticTruths(vote('m', { permitWhen: { op: 'or', args: [] } })).permit).to.equal(false);
  });

  it('returns the denies truths aligned with vote.denies', () => {
    const v = vote('m', {
      denies: [
        { when: TRUE, reason: { code: 'a' } },
        { when: RESIDUAL, reason: { code: 'b' } },
        { when: FALSE, reason: { code: 'c' } },
        { when: or(FALSE, TRUE), reason: { code: 'd' } },
      ],
    });
    expect(staticTruths(v).denies).to.deep.equal([true, undefined, false, true]);
  });

  it('has no denies truths for a vote without denies', () => {
    expect(staticTruths(vote('m')).denies).to.deep.equal([]);
  });

  it('treats an indeterminate vote as not permitting and denying nothing listed', () => {
    const t = staticTruths(faulty('m', { permitWhen: TRUE, denies: [{ when: TRUE, reason: { code: 'x' } }] }));
    expect(t).to.deep.equal({ permit: false, denies: [] });
  });

  it('answers undefined for malformed filters instead of throwing', () => {
    const v = { model: 'm', permitWhen: 'nope', denyWhen: FALSE, cacheable: true, denies: [{ when: null, reason: { code: 'x' } }, 7] } as unknown as Vote;
    expect(staticTruths(v)).to.deep.equal({ permit: undefined, denies: [undefined, undefined] });
    expect(staticTruths(null as unknown as Vote)).to.deep.equal({ permit: undefined, denies: [] });
  });

  it('returns a frozen value', () => {
    const t = staticTruths(vote('m', { denies: [{ when: TRUE, reason: { code: 'a' } }] }));
    expect(Object.isFrozen(t)).to.equal(true);
    expect(Object.isFrozen(t.denies)).to.equal(true);
  });
});

describe('selectDenyReason', () => {
  describe('fallback', () => {
    it('reports no_access when there is no candidate', () => {
      expect(select({})).to.deep.equal({ code: 'no_access' });
    });

    it('reports residual_false when there is no candidate and the subject decided', () => {
      expect(select({ subjectEvaluated: true })).to.deep.equal({ code: 'residual_false' });
    });

    it('reports no_access when the votes give no candidate', () => {
      const votes = [vote('a', { permitWhen: RESIDUAL }), vote('b', { permitWhen: TRUE, reason: { code: 'unused' } })];
      expect(select({ votes, truths: [truths(undefined), truths(true)] })).to.deep.equal({ code: 'no_access' });
    });
  });

  describe('core candidates', () => {
    it('reports a core denial', () => {
      expect(select({ core: [{ code: 'unattended' }] })).to.deep.equal({ code: 'unattended' });
    });

    it('keeps an engine fault without a model', () => {
      expect(select({ core: [{ code: 'model_error' }] })).to.deep.equal({ code: 'model_error' });
    });

    it('lets a core denial beat the model candidates by priority', () => {
      const votes = [vote('rbac', { reason: { code: 'role_too_low', ladder: 'project', role: 'viewer', needed: 'editor' } })];
      expect(select({ core: [{ code: 'ceiling' }], votes, truths: [truths(false)] })).to.deep.equal({ code: 'ceiling' });
    });
  });

  describe('vote candidates', () => {
    it('counts a denies entry whose truth is true, stamped with the vote model', () => {
      const votes = [vote('abac', { permitWhen: TRUE, denyWhen: TRUE, denies: [{ when: TRUE, reason: { code: 'blocked', model: 'forged', rule: 'r1' } }] })];
      expect(select({ votes, truths: [truths(true, true)] })).to.deep.equal({ code: 'blocked', model: 'abac', rule: 'r1' });
    });

    it('does not count a denies entry whose truth is false or unknown', () => {
      const denies = [
        { when: FALSE, reason: { code: 'x' } },
        { when: RESIDUAL, reason: { code: 'y' } },
      ];
      const votes = [vote('abac', { denies })];
      expect(select({ votes, truths: [truths(true, false, undefined)] })).to.deep.equal({ code: 'no_access' });
      expect(select({ votes, truths: [truths(true, false, undefined)], subjectEvaluated: true })).to.deep.equal({ code: 'residual_false' });
    });

    it('counts vote.reason when the permit truth is false', () => {
      const votes = [vote('rbac', { reason: { code: 'role_too_low', model: 'other', ladder: 'project' } })];
      expect(select({ votes, truths: [truths(false)] })).to.deep.equal({ code: 'role_too_low', model: 'rbac', ladder: 'project' });
    });

    it('does not count vote.reason when the vote permits', () => {
      const votes = [vote('rbac', { permitWhen: TRUE, reason: { code: 'role_too_low' } })];
      expect(select({ votes, truths: [truths(true)] })).to.deep.equal({ code: 'no_access' });
    });

    it('counts vote.reason for an unknown permit truth only when the subject decided', () => {
      const votes = [vote('rbac', { permitWhen: RESIDUAL, reason: { code: 'tag_missing', tag: 'hr' } })];
      expect(select({ votes, truths: [truths(undefined)] })).to.deep.equal({ code: 'no_access' });
      expect(select({ votes, truths: [truths(undefined)], subjectEvaluated: true })).to.deep.equal({ code: 'tag_missing', tag: 'hr', model: 'rbac' });
    });

    it('reports model_error for an indeterminate vote, without the error text or its own reasons', () => {
      const votes = [faulty('bad', { reason: { code: 'unattended' }, denies: [{ when: TRUE, reason: { code: 'unattended' } }] })];
      const r = select({ votes, truths: [truths(false, true)] });
      expect(r).to.deep.equal({ code: 'model_error', model: 'bad' });
      expect(JSON.stringify(r)).not.to.contain('secret');
    });

    it('drops a model field when the vote has no usable model name', () => {
      const votes = [{ ...vote(''), reason: { code: 'x', model: 'forged' } }];
      expect(select({ votes, truths: [truths(false)] })).to.deep.equal({ code: 'x' });
    });
  });

  describe('order', () => {
    it('follows DEFAULT_DENY_PRIORITY: unattended < ceiling < no_access < model_error', () => {
      const all: DenyReason[] = [{ code: 'model_error' }, { code: 'no_access' }, { code: 'ceiling' }, { code: 'unattended' }];
      expect(select({ core: all }).code).to.equal('unattended');
      expect(select({ core: all.slice(0, 3) }).code).to.equal('ceiling');
      expect(select({ core: all.slice(0, 2) }).code).to.equal('no_access');
    });

    it('lets a model reason with priority 100 beat a ceiling out_of_scope at 200 (canvas C6)', () => {
      const votes = [vote('abac', { denyWhen: TRUE, denies: [{ when: TRUE, reason: { code: 'agents_disabled', priority: 100 } }] })];
      const r = select({ core: [{ code: 'out_of_scope', priority: 200 }], votes, truths: [truths(false, true)] });
      expect(r).to.deep.equal({ code: 'agents_disabled', priority: 100, model: 'abac' });
    });

    it('breaks a priority tie by sortKey', () => {
      const votes = [vote('m', { reason: { code: 'branch', priority: 300, sortKey: 'b' } }), vote('n', { reason: { code: 'branch', priority: 300, sortKey: 'a' } })];
      expect(select({ votes, truths: [truths(false), truths(false)] })).to.deep.equal({ code: 'branch', priority: 300, sortKey: 'a', model: 'n' });
    });

    it('breaks a full tie by the payload', () => {
      const a = vote('m', {
        denyWhen: TRUE,
        denies: [
          { when: TRUE, reason: { code: 'rule', rule: 'zeta' } },
          { when: TRUE, reason: { code: 'rule', rule: 'alpha' } },
        ],
      });
      expect(select({ votes: [a], truths: [truths(false, true, true)] })).to.deep.equal({ code: 'rule', rule: 'alpha', model: 'm' });
    });

    it('prefers the reason without a model over the same reason with one', () => {
      expect(select({ core: [{ code: 'model_error' }], votes: [faulty('a')], truths: [truths(false)] })).to.deep.equal({ code: 'model_error' });
    });

    it('chooses the same reason when only the explicit default priority differs', () => {
      const one: DenyReason = { code: 'ceiling' };
      const two: DenyReason = { code: 'ceiling', priority: 200 };
      expect(select({ core: [one, two] })).to.deep.equal(select({ core: [two, one] }));
    });

    it('chooses the same reason when a Date and its ISO string tie', () => {
      const at = new Date('2026-01-01T00:00:00.000Z');
      const one: DenyReason = { code: 'expired', at };
      const two: DenyReason = { code: 'expired', at: at.toISOString() };
      expect(select({ core: [one, two] })).to.deep.equal(select({ core: [two, one] }));
    });
  });

  describe('first-applicable', () => {
    const first = vote('first', { reason: { code: 'role_too_low' } });
    const deciding = vote('deciding', { denyWhen: TRUE, denies: [{ when: TRUE, reason: { code: 'blocked', priority: 600 } }] });
    const later = vote('later', { reason: { code: 'unattended_like', priority: 1 } });

    it('counts only the deciding vote when there is one', () => {
      const r = select({ algorithm: 'first-applicable', votes: [first, deciding, later], truths: [truths(false), truths(false, true), truths(false)], deciding });
      expect(r).to.deep.equal({ code: 'blocked', priority: 600, model: 'deciding' });
    });

    it('counts every vote without a deciding vote', () => {
      const r = select({ algorithm: 'first-applicable', votes: [first, deciding, later], truths: [truths(false), truths(false, true), truths(false)] });
      expect(r).to.deep.equal({ code: 'unattended_like', priority: 1, model: 'later' });
    });

    it('ignores deciding under other algorithms', () => {
      const r = select({ algorithm: 'deny-overrides', votes: [first, deciding, later], truths: [truths(false), truths(false, true), truths(false)], deciding });
      expect(r.code).to.equal('unattended_like');
    });

    it('reports model_error when the deciding vote is indeterminate', () => {
      const bad = faulty('bad');
      const r = select({ algorithm: 'first-applicable', votes: [first, bad, later], truths: [truths(false), truths(false), truths(false)], deciding: bad });
      expect(r).to.deep.equal({ code: 'model_error', model: 'bad' });
    });
  });

  describe('hygiene', () => {
    it('returns a fresh deeply frozen copy', () => {
      const reason = { code: 'tag_missing', tags: ['a', 'b'], meta: { n: 1 } };
      const v = vote('rbac', { reason });
      const r = select({ votes: [v], truths: [truths(false)] });
      expect(r).not.to.equal(reason);
      expect(Object.isFrozen(r)).to.equal(true);
      expect(Object.isFrozen(r.tags)).to.equal(true);
      expect(Object.isFrozen(r.meta)).to.equal(true);
      expect(reason).to.deep.equal({ code: 'tag_missing', tags: ['a', 'b'], meta: { n: 1 } });
    });

    it('returns a fresh copy of a core reason', () => {
      const core: DenyReason = { code: 'ceiling' };
      const r = select({ core: [core] });
      expect(r).not.to.equal(core);
      expect(Object.isFrozen(r)).to.equal(true);
    });

    it('skips entries without a string code', () => {
      const core = [{ code: 5 }, null, 'unattended', { priority: 0 }, { code: '' }] as unknown as DenyReason[];
      expect(select({ core })).to.deep.equal({ code: 'no_access' });
      const votes = [vote('m', { reason: { code: 7 } as unknown as DenyReason, denies: [{ when: TRUE, reason: null as unknown as DenyReason }] })];
      expect(select({ votes, truths: [truths(false, true)] })).to.deep.equal({ code: 'no_access' });
    });

    it('skips a reason whose getter throws and keeps the others', () => {
      const evil = Object.defineProperty({ code: 'evil' }, 'boom', {
        enumerable: true,
        get() {
          throw new Error('boom');
        },
      }) as DenyReason;
      expect(select({ core: [evil, { code: 'no_access' }] })).to.deep.equal({ code: 'no_access' });
    });

    it('reads a getter-backed code once', () => {
      let reads = 0;
      const shifty = {
        get code() {
          reads++;
          return reads === 1 ? 'ceiling' : 'unattended';
        },
      } as DenyReason;
      expect(select({ core: [shifty, { code: 'no_access' }] })).to.deep.equal({ code: 'ceiling' });
      expect(reads).to.equal(1);
    });

    it('treats an unreadable vote as an engine fault', () => {
      const trap = new Proxy(
        {},
        {
          get() {
            throw new Error('trap');
          },
        },
      ) as Vote;
      expect(select({ votes: [trap], truths: [truths(false)] })).to.deep.equal({ code: 'model_error' });
    });

    it('treats malformed lists as an engine fault', () => {
      expect(select({ core: 'x' as unknown as DenyReason[] })).to.deep.equal({ code: 'model_error' });
      expect(select({ votes: {} as unknown as Vote[] })).to.deep.equal({ code: 'model_error' });
    });

    it('falls back to the static truths when the truths are missing or malformed', () => {
      const v = vote('m', { denyWhen: TRUE, denies: [{ when: TRUE, reason: { code: 'blocked' } }] });
      expect(select({ votes: [v], truths: [] })).to.deep.equal({ code: 'blocked', model: 'm' });
      expect(select({ votes: [v], truths: [{ permit: 'yes' } as unknown as VoteTruths] })).to.deep.equal({ code: 'blocked', model: 'm' });
    });

    it('drops values that are not plain data', () => {
      const r = select({ core: [{ code: 'x', fn: () => 1, big: 1n, nested: { ok: 1, sym: Symbol('s') }, list: [1, undefined, () => 2] } as unknown as DenyReason] });
      expect(r).to.deep.equal({ code: 'x', nested: { ok: 1 }, list: [1, null, null] });
    });

    it('survives a cyclic payload', () => {
      const cyc: Record<string, unknown> = { code: 'cyc' };
      cyc.self = cyc;
      expect(select({ core: [cyc as DenyReason] })).to.deep.equal({ code: 'cyc' });
    });

    const revoked = (): DenyReason => {
      const { proxy, revoke } = Proxy.revocable({ code: 'unattended' }, {});
      revoke();
      return proxy as DenyReason;
    };

    it('skips a revoked proxy in core wherever it stands', () => {
      expect(select({ core: [revoked(), { code: 'ceiling' }] })).to.deep.equal({ code: 'ceiling' });
      expect(select({ core: [{ code: 'ceiling' }, revoked()] })).to.deep.equal({ code: 'ceiling' });
    });

    it('skips a reason holding a revoked proxy, in any order', () => {
      const bad = { code: 'early', priority: 1, payload: revoked() } as DenyReason;
      expect(select({ core: [bad, { code: 'ceiling' }] })).to.deep.equal({ code: 'ceiling' });
      expect(select({ core: [{ code: 'ceiling' }, bad] })).to.deep.equal({ code: 'ceiling' });
    });

    it('keeps the other denies of a vote when one reason is a revoked proxy', () => {
      const v = vote('m', {
        denyWhen: TRUE,
        denies: [
          { when: TRUE, reason: revoked() },
          { when: TRUE, reason: { code: 'blocked', priority: 1 } },
        ],
      });
      expect(select({ votes: [v], truths: [truths(false, true, true)] })).to.deep.equal({ code: 'blocked', priority: 1, model: 'm' });
    });

    it('keeps the other denies of a vote when one entry is a revoked proxy', () => {
      const v = vote('m', { denyWhen: TRUE, denies: [revoked() as unknown as { when: ResourceFilter; reason: DenyReason }, { when: TRUE, reason: { code: 'blocked', priority: 1 } }] });
      expect(select({ votes: [v], truths: [truths(false, true, true)] })).to.deep.equal({ code: 'blocked', priority: 1, model: 'm' });
      expect(select({ votes: [v], truths: [] })).to.deep.equal({ code: 'blocked', priority: 1, model: 'm' });
    });

    it('treats a revoked vote as an engine fault in any position and still counts the others', () => {
      const good = vote('m', { reason: { code: 'role_too_low', priority: 950 } });
      const bad = revoked() as unknown as Vote;
      expect(select({ votes: [bad, good], truths: [truths(false), truths(false)] })).to.deep.equal({ code: 'model_error' });
      expect(select({ votes: [good, bad], truths: [truths(false), truths(false)] })).to.deep.equal({ code: 'model_error' });
      const strong = vote('m', { reason: { code: 'role_too_low' } });
      expect(select({ votes: [bad, strong], truths: [truths(false), truths(false)] })).to.deep.equal({ code: 'role_too_low', model: 'm' });
    });

    it('falls back to static truths when a truths entry is a revoked proxy', () => {
      const v = vote('m', { denyWhen: TRUE, denies: [{ when: TRUE, reason: { code: 'blocked' } }] });
      expect(select({ votes: [v], truths: [revoked() as unknown as VoteTruths] })).to.deep.equal({ code: 'blocked', model: 'm' });
    });

    it('does not read permitWhen when the truths are supplied', () => {
      const v = Object.defineProperty({ ...vote('m', { reason: { code: 'role_too_low' } }) }, 'permitWhen', {
        enumerable: true,
        get() {
          throw new Error('read');
        },
      }) as Vote;
      expect(select({ votes: [v], truths: [truths(false)] })).to.deep.equal({ code: 'role_too_low', model: 'm' });
    });

    it('skips a reason whose payload shares subtrees past the value budget, quickly', () => {
      let node: unknown = 'leaf';
      for (let i = 0; i < 40; i++) node = [node, node];
      const started = Date.now();
      const r = select({ core: [{ code: 'huge', priority: 0, node } as DenyReason, { code: 'ceiling' }] });
      expect(r).to.deep.equal({ code: 'ceiling' });
      expect(Date.now() - started).to.be.below(1000);
    });

    it('copies a payload within the value budget', () => {
      let node: unknown = 'leaf';
      for (let i = 0; i < 8; i++) node = [node, node];
      const r = select({ core: [{ code: 'big', node } as DenyReason] });
      expect(JSON.stringify(r.node)).to.equal(JSON.stringify(node));
    });

    it('does not mutate its input', () => {
      const core = Object.freeze([Object.freeze({ code: 'ceiling' })]);
      const votes = Object.freeze([Object.freeze(vote('m', { reason: Object.freeze({ code: 'role_too_low' }) }))]);
      const t = Object.freeze([Object.freeze(truths(false))]);
      expect(() => selectDenyReason({ core, votes, truths: t, algorithm: 'deny-overrides', subjectEvaluated: false })).not.to.throw();
    });
  });

  describe('properties', () => {
    const CODES = ['unattended', 'ceiling', 'delegate', 'no_access', 'role_too_low', 'model_error', 'custom', 'other'];
    const reasonArb: fc.Arbitrary<DenyReason> = fc
      .record(
        {
          code: fc.constantFrom(...CODES),
          priority: fc.oneof(fc.integer({ min: 0, max: 900 }), fc.constantFrom(100, 200, 400)),
          sortKey: fc.constantFrom('a', 'b', 'c', ''),
          model: fc.constantFrom('forged', 'x'),
          tag: fc.constantFrom('t1', 't2'),
        },
        { requiredKeys: ['code'] },
      )
      .map((r) => r as DenyReason);
    const truthArb = fc.constantFrom<boolean | undefined>(true, false, undefined);
    const voteArb = fc.record({
      model: fc.constantFrom('rbac', 'abac', 'fs', 'acl'),
      error: fc.boolean(),
      reason: fc.option(reasonArb, { nil: undefined }),
      denies: fc.array(fc.record({ reason: reasonArb, truth: truthArb }), { maxLength: 3 }),
      permit: truthArb,
    });
    const inputArb = fc.record({
      core: fc.array(reasonArb, { maxLength: 3 }),
      votes: fc.array(voteArb, { maxLength: 5 }),
      subjectEvaluated: fc.boolean(),
    });

    type Gen = { core: DenyReason[]; votes: { model: string; error: boolean; reason?: DenyReason; denies: { reason: DenyReason; truth: boolean | undefined }[]; permit: boolean | undefined }[]; subjectEvaluated: boolean };

    const build = (g: Gen): { votes: Vote[]; truths: VoteTruths[] } => ({
      votes: g.votes.map((v) => {
        const base: Vote = v.error ? faulty(v.model) : vote(v.model, { permitWhen: RESIDUAL, denyWhen: RESIDUAL });
        const extra: { -readonly [K in keyof Vote]?: Vote[K] } = { denies: v.denies.map((d) => ({ when: RESIDUAL, reason: d.reason })) };
        if (v.reason) extra.reason = v.reason;
        return { ...base, ...extra };
      }),
      truths: g.votes.map((v) => truths(v.permit, ...v.denies.map((d) => d.truth))),
    });

    // Reference list of candidates, written independently of the module.
    const candidates = (g: Gen): DenyReason[] => {
      const out: DenyReason[] = [...g.core];
      for (const v of g.votes) {
        if (v.error) {
          out.push({ code: 'model_error', model: v.model });
          continue;
        }
        for (const d of v.denies) if (d.truth === true) out.push({ ...d.reason, model: v.model });
        if (v.reason && (v.permit === false || (v.permit === undefined && g.subjectEvaluated))) out.push({ ...v.reason, model: v.model });
      }
      return out;
    };

    const shuffled = <T>(xs: readonly T[], keys: readonly number[]): T[] =>
      xs
        .map((x, i) => [x, keys[i % Math.max(1, keys.length)] ?? 0, i] as const)
        .sort((a, b) => a[1] - b[1] || a[2] - b[2])
        .map((x) => x[0]);

    it('B36: shuffling votes (truths aligned) and core never changes the result', () => {
      fc.assert(
        fc.property(inputArb, fc.array(fc.integer(), { minLength: 1, maxLength: 8 }), fc.array(fc.integer(), { minLength: 1, maxLength: 8 }), (g, k1, k2) => {
          const { votes, truths: t } = build(g);
          const base = selectDenyReason({ core: g.core, votes, truths: t, algorithm: 'deny-overrides', subjectEvaluated: g.subjectEvaluated });
          const pairs = shuffled(
            votes.map((v, i) => [v, t[i]] as const),
            k1,
          );
          const again = selectDenyReason({ core: shuffled(g.core, k2), votes: pairs.map((p) => p[0]), truths: pairs.map((p) => p[1]), algorithm: 'deny-overrides', subjectEvaluated: g.subjectEvaluated });
          expect(again).to.deep.equal(base);
        }),
        { numRuns: 400 },
      );
    });

    it('returns a candidate (or the fallback) that no candidate beats', () => {
      fc.assert(
        fc.property(inputArb, (g) => {
          const { votes, truths: t } = build(g);
          const r = selectDenyReason({ core: g.core, votes, truths: t, algorithm: 'deny-overrides', subjectEvaluated: g.subjectEvaluated });
          const all = candidates(g);
          if (all.length === 0) {
            expect(r).to.deep.equal({ code: g.subjectEvaluated ? 'residual_false' : 'no_access' });
            return;
          }
          expect(all.some((c) => sameData(c, r))).to.equal(true);
          for (const c of all) expect(compareDenyReasons(c, r)).to.be.at.least(0);
          expect(Object.isFrozen(r)).to.equal(true);
        }),
        { numRuns: 400 },
      );
    });

    it('first-applicable with a deciding vote depends on that vote only', () => {
      fc.assert(
        fc.property(inputArb, fc.nat(), (g, pick) => {
          fc.pre(g.votes.length > 0);
          const { votes, truths: t } = build(g);
          const i = pick % votes.length;
          const r = selectDenyReason({ core: g.core, votes, truths: t, algorithm: 'first-applicable', deciding: votes[i], subjectEvaluated: g.subjectEvaluated });
          const alone = selectDenyReason({ core: g.core, votes: [votes[i]], truths: [t[i]], algorithm: 'first-applicable', deciding: votes[i], subjectEvaluated: g.subjectEvaluated });
          expect(r).to.deep.equal(alone);
        }),
        { numRuns: 300 },
      );
    });
  });
});
