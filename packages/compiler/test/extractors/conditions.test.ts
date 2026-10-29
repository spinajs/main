import { expect } from 'chai';
import { createProgramFromTsconfig, createContext, extractServices } from '../../src/index.js';

describe('conditionOf through extractServices', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/pkg-basic/tsconfig.json');
  const ctx = createContext(loaded, 'pkg-basic', 'test/fixtures/pkg-basic');
  const file = loaded.sourceFiles.find((f) => f.fileName.endsWith('conditions.ts'))!;
  const services = extractServices(ctx, file);
  const cond = (n: string) => services.find((s) => s.className === n)!.condition;

  it('module-level @Injectable has no condition', () => {
    expect(cond('ConditionalBootstrapper')).to.equal(undefined);
  });
  it('unconditional registration inside bootstrap() is dynamic', () => {
    expect(cond('FeatureA')).to.deep.equal({ kind: 'dynamic', reason: 'registered in bootstrap()' });
  });
  it('guarded by a @Config property', () => {
    expect(cond('FeatureB')).to.deep.equal({ kind: 'config', path: 'basic.featureB' });
  });
  it('guarded by config.get()', () => {
    expect(cond('FeatureC')).to.deep.equal({ kind: 'config', path: 'basic.featureC' });
  });
  it('inside a loop is dynamic with the statement kind', () => {
    expect(cond('FeatureD')).to.deep.equal({ kind: 'dynamic', reason: 'inside ForStatement' });
  });
  it('every dynamic condition has a CMP003 info diagnostic', () => {
    expect(ctx.diagnostics.filter((d) => d.code === 'CMP003')).to.have.length(2);
  });
});

describe('conditionOf: branches, ternaries and nested config', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/pkg-basic/tsconfig.json');
  const ctx = createContext(loaded, 'pkg-basic', 'test/fixtures/pkg-basic');
  const file = loaded.sourceFiles.find((f) => f.fileName.endsWith('conditions-extra.ts'))!;
  const services = extractServices(ctx, file);
  const cond = (n: string) => services.find((s) => s.className === n)?.condition;

  it('else branch of a config guard is dynamic, not the guard', () => {
    expect(cond('ElseA')).to.deep.equal({ kind: 'dynamic', reason: 'else branch' });
  });
  it('ternary: true branch uses the config guard, false branch is dynamic', () => {
    expect(cond('TernA')).to.deep.equal({ kind: 'config', path: 'basic.featureB' });
    expect(cond('TernB')).to.deep.equal({ kind: 'dynamic', reason: 'else branch' });
  });
  it('&& short-circuit registration uses the config guard', () => {
    expect(cond('AndA')).to.deep.equal({ kind: 'config', path: 'basic.featureB' });
  });
  it('member of a @Config property joins the path', () => {
    expect(cond('NestedCfg')).to.deep.equal({ kind: 'config', path: 'feature.enabled' });
  });
  it('negated guard has a precise reason', () => {
    expect(cond('NegA')).to.deep.equal({ kind: 'dynamic', reason: 'non-config or negated guard' });
  });
});
