import { expect } from 'chai';
import { createProgramFromTsconfig, createContext, extractServices } from '../../src/index.js';

const loaded = createProgramFromTsconfig('test/fixtures/pkg-basic/tsconfig.json');
const ctx = createContext(loaded, 'pkg-basic', 'test/fixtures/pkg-basic');
const file = loaded.sourceFiles.find((f) => f.fileName.endsWith('services.ts'))!;
const services = extractServices(ctx, file);
const byName = (n: string) => services.find((s) => s.className === n)!;

describe('extractServices', () => {
  it('finds every @Injectable class', () => {
    expect(services.map((s) => s.className)).to.deep.equal(['SmtpMailer', 'Clock', 'Greeter', 'BasicBootstrapper']);
  });
  it('SmtpMailer: registeredAs base and self, singleton, sync', () => {
    expect(byName('SmtpMailer')).to.deep.include({
      id: 'pkg-basic:SmtpMailer',
      registeredAs: ['Mailer', 'SmtpMailer'],
      lifetime: 'singleton',
      async: false,
      bootstrapper: false,
      ctorInjects: [],
      propertyInjects: [],
    });
    expect(byName('SmtpMailer').source).to.deep.equal({ file: 'src/services.ts', line: 7, col: 1, package: 'pkg-basic' });
  });
  it('Clock: new-instance', () => {
    expect(byName('Clock')).to.deep.include({ registeredAs: ['Clock'], lifetime: 'new-instance', async: false });
  });
  it('Greeter: async, ctor and property injections', () => {
    const g = byName('Greeter');
    expect(g.async).to.be.true;
    expect(g.ctorInjects).to.deep.equal(['Clock']);
    expect(g.propertyInjects).to.deep.equal([
      { property: 'mailer', token: 'Mailer', optional: false, array: false },
      { property: 'clock', token: 'Clock', optional: false, array: false, concrete: true },
      { property: 'optionalMailer', token: 'Mailer', optional: true, array: false },
      { property: 'allMailers', token: 'Mailer', optional: false, array: true },
      { property: 'greeting', token: 'Configuration', optional: false, array: false },
      { property: 'log', token: 'Log', optional: false, array: false },
      { property: 'lazyClock', token: 'Clock', optional: false, array: false, lazy: true },
    ]);
  });
  it('Greeter: records awaited and un-awaited imperative DI.resolve calls', () => {
    const resolves = byName('Greeter').imperativeResolves!;
    expect(resolves.map(({ token, method, awaited }) => ({ token, method, awaited }))).to.deep.equal([
      { token: 'Clock', method: 'load', awaited: true },
      { token: 'Mailer', method: 'load', awaited: false },
    ]);
    expect(resolves[0].source).to.deep.include({ file: 'src/services.ts', package: 'pkg-basic' });
  });
  it('BasicBootstrapper: bootstrapper flag and per-child lifetime', () => {
    expect(byName('BasicBootstrapper')).to.deep.include({
      registeredAs: ['Bootstrapper', 'BasicBootstrapper'],
      lifetime: 'per-child',
      bootstrapper: true,
    });
    expect(byName('BasicBootstrapper').imperativeResolves).to.equal(undefined);
  });
});

describe('extractServices: generic intermediate bases', () => {
  const generic = loaded.sourceFiles.find((f) => f.fileName.endsWith('generic-bases.ts'))!;
  const found = extractServices(ctx, generic);

  it('detects AsyncService and Bootstrapper through an instantiated generic base', () => {
    expect(found.find((s) => s.className === 'StringAsync')!.async).to.be.true;
    expect(found.find((s) => s.className === 'StringBoot')!.bootstrapper).to.be.true;
  });
});

describe('extractServices: same class under different conditions', () => {
  it('keeps separate entries when conditions differ', () => {
    const file = loaded.sourceFiles.find((f) => f.fileName.endsWith('multi-condition.ts'))!;
    const multi = extractServices(ctx, file).filter((s) => s.className === 'Multi');
    expect(multi.map((s) => s.condition)).to.deep.equal([{ kind: 'config', path: 'basic.a' }, { kind: 'dynamic', reason: 'else branch' }]);
  });
});
