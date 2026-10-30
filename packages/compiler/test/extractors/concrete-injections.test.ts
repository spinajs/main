import { expect } from 'chai';
import { createProgramFromTsconfig, createContext, extractServices } from '../../src/index.js';

describe('extractServices: concrete and checked injections', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/doctor/concrete/tsconfig.json');
  const ctx = createContext(loaded, 'concrete', 'test/fixtures/doctor/concrete');
  const file = loaded.sourceFiles.find((f) => f.fileName.endsWith('consumer.ts'))!;
  const consumer = extractServices(ctx, file).find((s) => s.className === 'Consumer')!;
  const prop = (name: string) => consumer.propertyInjects.find((p) => p.property === name)!;

  it('marks non-abstract classes concrete, from the declared type or the explicit token', () => {
    expect(prop('plain').concrete).to.equal(true);
    expect(prop('explicitPlain').concrete).to.equal(true);
  });

  it('does not mark abstract classes, interfaces or arrays', () => {
    expect(prop('contract')).to.not.have.property('concrete');
    expect(prop('shape')).to.not.have.property('concrete');
    expect(prop('all')).to.not.have.property('concrete');
  });

  it('records { check: true } next to concrete', () => {
    expect(prop('checked')).to.deep.include({ concrete: true, check: true });
    expect(prop('checkedExplicit')).to.deep.include({ concrete: true, check: true });
    expect(prop('plain')).to.not.have.property('check');
  });

  it('marks concrete constructor tokens positionally', () => {
    expect(consumer.ctorInjects).to.deep.equal(['Plain', 'Contract']);
    expect(consumer.ctorConcrete).to.deep.equal([true, false]);
  });
});
