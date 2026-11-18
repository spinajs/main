import 'mocha';
import { expect } from 'chai';
import { coerceIn, finiteAfter, replayLocal, type ReplayPlan } from '../../src/formats/index.js';

const number = coerceIn(['number']);
const string = coerceIn(['string']);

describe('@spinajs/client/formats: the replay of Ajv coercions', () => {
  it('leaves an infinity in the data that a not branch coerced, as Ajv does', () => {
    const plan: ReplayPlan = { not: { coerce: number, ok: () => true } };
    expect(finiteAfter(plan, 'Infinity', false)).to.equal(false);
    expect(finiteAfter(plan, 'x', false)).to.equal(true);
  });

  it('does not assign to a root, whose container is still changed in place', () => {
    const plan: ReplayPlan = { not: { coerce: number, ok: () => true } };
    expect(finiteAfter(plan, 'Infinity', true)).to.equal(true);
    const deep: ReplayPlan = { not: { props: [['n', { coerce: number, ok: () => true }]], ok: () => true } };
    expect(finiteAfter(deep, { n: 'Infinity' }, true)).to.equal(false);
  });

  it('lets a later member turn the infinity back into text', () => {
    const plan: ReplayPlan = { anyOf: [{ coerce: number, ok: () => false }, { coerce: string, ok: () => true }] };
    expect(finiteAfter(plan, 'Infinity', false)).to.equal(true);
  });

  it('stops a not at the first child that fails', () => {
    const rejects = { coerce: number, ok: (v: unknown) => v === '1' };
    const plan: ReplayPlan = { not: { props: [['m', rejects], ['n', { coerce: number, ok: () => true }]], ok: () => true } };
    expect(finiteAfter(plan, { m: 'abc', n: 'Infinity' }, false)).to.equal(true);
    expect(finiteAfter(plan, { m: '1', n: 'Infinity' }, false)).to.equal(false);
  });

  it('follows a recursive schema by a back reference, and never changes its input', () => {
    const plan: ReplayPlan = { not: { props: [['next', { ref: { back: 0 } }], ['n', { coerce: number, ok: () => true }]], ok: () => true } };
    const input = { next: { next: { n: 'Infinity' } } };
    expect(finiteAfter({ ref: plan }, input, false)).to.equal(false);
    expect(input).to.deep.equal({ next: { next: { n: 'Infinity' } } });
  });

  it('hands the next branch what a failed unwrap left in the variable', () => {
    const local = replayLocal({ not: { coerce: number, ok: () => true } });
    expect(local([['5', 'x']])).to.deep.equal(['5', 'x']);
  });

  it('scans a very large value without growing the stack', () => {
    expect(finiteAfter({ not: { coerce: number, ok: () => true } }, new Array<number>(300000).fill(1), false)).to.equal(true);
  });
});
