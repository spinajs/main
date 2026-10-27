import { expect } from 'chai';
import { createProgramFromTsconfig } from '../src/index.js';
import ts from 'typescript';

describe('pkg-basic fixture', () => {
  it('type-checks under typescript 5.9', () => {
    const { program } = createProgramFromTsconfig('test/fixtures/pkg-basic/tsconfig.json');
    const errors = ts.getPreEmitDiagnostics(program).filter((d) => d.category === ts.DiagnosticCategory.Error);
    expect(errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).to.deep.equal([]);
  });
});
