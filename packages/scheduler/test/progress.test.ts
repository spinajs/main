import { expect } from 'chai';
import { computeRunProgress, normalizeProgress } from '../src/index.js';

const state = (s: Partial<Parameters<typeof computeRunProgress>[0]>) =>
  computeRunProgress({
    completedWeight: 0,
    currentWeight: null,
    currentFraction: 0,
    plannedWeight: 0,
    freeProgress: null,
    ...s,
  });

describe('progress', () => {
  it('normalizes numbers and done/total', () => {
    expect(normalizeProgress(40).fraction).to.eq(0.4);
    expect(normalizeProgress(140).fraction).to.eq(1);
    expect(normalizeProgress(-3).fraction).to.eq(0);
    expect(normalizeProgress({ done: 3, total: 12, message: 'x' })).to.deep.eq({
      fraction: 0.25,
      done: 3,
      total: 12,
      message: 'x',
    });
    expect(normalizeProgress({ done: 3, total: 0 }).fraction).to.eq(0);
  });

  it('uses free progress when no step was started', () => {
    expect(state({ freeProgress: 0.42 })).to.eq(42);
    expect(state({})).to.eq(0);
  });

  it('rolls steps up against the planned weight', () => {
    expect(state({ completedWeight: 2, currentWeight: 1, currentFraction: 0.5, plannedWeight: 4 })).to.eq(62);
    expect(state({ completedWeight: 1, currentWeight: 1, currentFraction: 0.5, plannedWeight: 4 })).to.eq(37);
    expect(state({ completedWeight: 3, currentWeight: 1, currentFraction: 0.5, plannedWeight: 4 })).to.eq(87);
  });

  it('falls back to the steps seen so far without a plan and never reports 100', () => {
    expect(state({ completedWeight: 1, currentWeight: 1, currentFraction: 0.5 })).to.eq(75);
    expect(state({ completedWeight: 4, plannedWeight: 4 })).to.eq(99);
  });
});
