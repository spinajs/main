import { expect } from 'chai';
import { createContext, createProgramFromTsconfig, extractValues } from '../../src/index.js';

describe('the status of a reply class that handles an exception', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/unit/tsconfig.json');
  const ctx = createContext(loaded, 'unit', 'test/fixtures/unit');
  const valuesOf = (suffix: string) => extractValues(ctx, loaded.sourceFiles.find((f) => f.fileName.endsWith(`/${suffix}`))!).map((v) => [v.mapKey, v.value]);

  it('is the _errorCode of the class, read from its source', () => {
    const values = valuesOf('response-status.ts');
    expect(values).to.deep.include(['A', { response: 'Accepted', status: 202 }]);
    expect(values).to.deep.include(['D', { response: 'Teapot', status: 418 }]);
  });

  it('is the _errorCode a dependency class sets in its built JavaScript', () => {
    const values = valuesOf('response-status.ts');
    expect(values).to.deep.include(['B', { response: 'Missing', status: 404 }]);
    expect(values).to.deep.include(['C', { response: 'Raw', status: 200 }]);
  });

  it('is unknown, not the status of a base, when the nearest _errorCode cannot be read', () => {
    expect(valuesOf('response-status.ts')).to.deep.include(['F', { response: 'Computed' }]);
    expect(ctx.diagnostics.filter((d) => d.code === 'CMP004').map((d) => d.message)).to.include('cannot determine the HTTP status of Computed, which handles exceptions');
  });

  it('is unknown for a CodedHttpExceptionResponse, which answers with the status of its exception', () => {
    expect(valuesOf('response-status.ts')).to.deep.include(['G', { response: 'Coded' }]);
  });

  it('is read from a base that is a class expression', () => {
    expect(valuesOf('response-status.ts')).to.deep.include(['H', { response: 'FromExpression', status: 202 }]);
  });

  it('is unknown when the built JavaScript of a dependency holds two classes of its name', () => {
    expect(valuesOf('response-status.ts')).to.deep.include(['I', { response: 'FromDecoy' }]);
  });

  it('is unknown for a class that only shares the name of an http reply', () => {
    expect(valuesOf('response-status-lookalike.ts')).to.deep.equal([['E', { response: 'Fine' }]]);
    expect(ctx.diagnostics.filter((d) => d.code === 'CMP004').map((d) => d.message)).to.include('cannot determine the HTTP status of Fine, which handles exceptions');
  });
});
