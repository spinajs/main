import { expect } from 'chai';
import { createProgramFromTsconfig, createContext, extractServices } from '../../src/index.js';

describe('extractServices: imperative DI.resolve (consumer gap S11)', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/doctor/s11/tsconfig.json');
  const ctx = createContext(loaded, 's11', 'test/fixtures/doctor/s11');
  const file = loaded.sourceFiles.find((f) => f.fileName.endsWith('principal-middleware.ts'))!;

  it('records each resolve with its await state', () => {
    const pm = extractServices(ctx, file).find((s) => s.className === 'PrincipalMiddleware')!;
    expect(pm.imperativeResolves?.map(({ token, method, awaited }) => ({ token, method, awaited }))).to.deep.equal([
      { token: 'AuthzService', method: 'rootService', awaited: false },
      { token: 'AuthzService', method: 'fixed', awaited: true },
    ]);
  });
});
