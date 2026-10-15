import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { AuthzAdminFailure, AuthzConfigError } from '@spinajs/authz';

import { computeClosures, latestPerSet, readMaxSetDepth } from '../../src/index.js';
import type { MembershipEdge } from '../../src/index.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const H = 3_600_000;
const T0 = Date.parse('2026-10-14T00:00:00.000Z');
const at = (hours: number) => new Date(T0 + hours * H);
const edge = (memberKey: string, setKey: string, expiresAt: Date | null = null): MembershipEdge => ({ memberKey, setKey, expiresAt });

function source(edges: readonly MembershipEdge[]) {
  const reads: string[][] = [];
  return {
    reads,
    read: async (keys: readonly string[]) => {
      reads.push([...keys].sort());
      return edges.filter((e) => keys.includes(e.memberKey));
    },
  };
}

const closures = (members: string[], edges: readonly MembershipEdge[], maxDepth = 8) => computeClosures(members, source(edges).read, maxDepth);

const CHAIN = [edge('user:u', 'g:3#m'), edge('g:3#m', 'g:2#m'), edge('g:2#m', 'g:1#m')];

describe('computeClosures (design §4.3)', () => {
  it('walks nested sets three levels up, with the shortest depth', async () => {
    expect((await closures(['user:u'], CHAIN)).get('user:u')).to.deep.equal([
      { memberKey: 'user:u', setKey: 'g:1#m', depth: 3, expiresAt: null },
      { memberKey: 'user:u', setKey: 'g:2#m', depth: 2, expiresAt: null },
      { memberKey: 'user:u', setKey: 'g:3#m', depth: 1, expiresAt: null },
    ]);
  });

  it('expires a path at its earliest edge and a membership at its latest path', async () => {
    const edges = [edge('user:u', 'g:3#m', at(2)), edge('g:3#m', 'g:2#m', at(1)), edge('g:2#m', 'g:1#m'), edge('g:3#m', 'g:1#m', at(3))];
    expect((await closures(['user:u'], edges)).get('user:u')).to.deep.equal([
      // u-3-2-1 lives until 1h, u-3-1 until 2h: the later one wins.
      { memberKey: 'user:u', setKey: 'g:1#m', depth: 2, expiresAt: at(2) },
      { memberKey: 'user:u', setKey: 'g:2#m', depth: 2, expiresAt: at(1) },
      { memberKey: 'user:u', setKey: 'g:3#m', depth: 1, expiresAt: at(2) },
    ]);
  });

  it('a longer path can widen the expiry the shortest one found', async () => {
    const edges = [edge('user:u', 'g:a#m', at(1)), edge('user:u', 'g:b#m'), edge('g:b#m', 'g:a#m')];
    expect((await closures(['user:u'], edges)).get('user:u')).to.deep.equal([
      { memberKey: 'user:u', setKey: 'g:a#m', depth: 1, expiresAt: null },
      { memberKey: 'user:u', setKey: 'g:b#m', depth: 1, expiresAt: null },
    ]);
  });

  it('removing an edge shrinks the closure', async () => {
    const before = (await closures(['user:u'], CHAIN)).get('user:u')!.map((r) => r.setKey);
    const after = (await closures(['user:u'], CHAIN.slice(0, 2))).get('user:u')!.map((r) => r.setKey);
    expect(before).to.deep.equal(['g:1#m', 'g:2#m', 'g:3#m']);
    expect(after).to.deep.equal(['g:2#m', 'g:3#m']);
  });

  it('a member without edges has no rows', async () => {
    expect((await closures(['user:x'], CHAIN)).get('user:x')).to.deep.equal([]);
  });

  it('refuses a set that reaches itself (set_cycle)', async () => {
    const err = await closures(['g:1#m'], [edge('g:1#m', 'g:2#m'), edge('g:2#m', 'g:1#m')]).catch((e: unknown) => e);
    expect(err).to.be.instanceOf(AuthzAdminFailure).and.include({ code: 'set_cycle' });
  });

  it('terminates on a cycle above the member that the member is not part of', async () => {
    const out = await closures(['user:u'], [edge('user:u', 'g:a#m'), edge('g:a#m', 'g:b#m'), edge('g:b#m', 'g:a#m')]);
    expect(out.get('user:u')!.map((r) => [r.setKey, r.depth])).to.deep.equal([['g:a#m', 1], ['g:b#m', 2]]);
  });

  it('refuses a set more than maxDepth levels up (set_too_deep), and accepts it at maxDepth', async () => {
    const err = await closures(['user:u'], CHAIN, 2).catch((e: unknown) => e);
    expect(err).to.be.instanceOf(AuthzAdminFailure).and.include({ code: 'set_too_deep' });
    expect((await closures(['user:u'], CHAIN, 3)).get('user:u')).to.have.length(3);
  });

  it('reads the edges of all members level by level, each node once', async () => {
    const s = source([edge('user:u', 'g:1#m'), edge('user:v', 'g:1#m'), edge('g:1#m', 'g:0#m')]);
    const out = await computeClosures(['user:u', 'user:v'], s.read, 8);
    expect(s.reads).to.deep.equal([['user:u', 'user:v'], ['g:1#m'], ['g:0#m']]);
    expect(out.get('user:v')!.map((r) => r.setKey)).to.deep.equal(['g:0#m', 'g:1#m']);
  });

  it('latestPerSet keeps one entry per set at its latest expiry, none when a row never expires', () => {
    expect(latestPerSet([{ setKey: 'b', expiresAt: at(1) }, { setKey: 'a', expiresAt: at(2) }, { setKey: 'b', expiresAt: at(3) }, { setKey: 'a', expiresAt: null }])).to.deep.equal([{ setKey: 'a' }, { setKey: 'b', expiresAt: at(3) }]);
  });

  it('readMaxSetDepth takes the default for undefined and refuses a non-positive or fractional value', () => {
    expect(readMaxSetDepth(undefined)).to.eq(8);
    expect(readMaxSetDepth(3)).to.eq(3);
    for (const bad of [0, -1, 1.5, '4', null]) expect(() => readMaxSetDepth(bad), String(bad)).to.throw(AuthzConfigError);
  });
});
