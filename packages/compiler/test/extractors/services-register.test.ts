import { expect } from 'chai';
import { createProgramFromTsconfig, createContext, extractServices } from '../../src/index.js';

describe('extractServices: DI.register at module level', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/pkg-basic/tsconfig.json');
  const ctx = createContext(loaded, 'pkg-basic', 'test/fixtures/pkg-basic');
  const file = loaded.sourceFiles.find((f) => f.fileName.endsWith('register.ts'))!;
  const services = extractServices(ctx, file);

  it('records .as(Base) and .asSelf().singleInstance()', () => {
    expect(services).to.have.length(2);
    expect(services[0]).to.deep.include({
      className: 'LogMailer',
      registeredAs: ['Mailer'],
      lifetime: 'singleton',
      async: false,
      bootstrapper: false,
      ctorInjects: [],
      propertyInjects: [],
    });
    expect(services[0].source).to.deep.equal({ file: 'src/register.ts', line: 7, col: 1, package: 'pkg-basic' });
    expect(services[1]).to.deep.include({ className: 'NullMailer', registeredAs: ['NullMailer'], lifetime: 'singleton' });
  });
});

describe('extractServices: one entry per class', () => {
  it('merges @Injectable and DI.register of the same class', () => {
    const loaded = createProgramFromTsconfig('test/fixtures/pkg-basic/tsconfig.json');
    const ctx = createContext(loaded, 'pkg-basic', 'test/fixtures/pkg-basic');
    const file = loaded.sourceFiles.find((f) => f.fileName.endsWith('dedupe.ts'))!;
    const services = extractServices(ctx, file);
    expect(services).to.have.length(1);
    expect(services[0].registeredAs).to.deep.equal(['Dual', 'DualAlias']);
  });
});
