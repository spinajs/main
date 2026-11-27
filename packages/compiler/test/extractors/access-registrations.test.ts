import { expect } from 'chai';
import { createContext, createProgramFromTsconfig } from '../../src/index.js';
import { accessResources } from '../../src/extractors/access-resources.js';

const REFUSED = 'with other options; authz-orm refuses the second registration when the application starts';

describe('access resource registrations of one class', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/unit/tsconfig.json');
  const ctx = createContext(loaded, 'unit', 'test/fixtures/unit');
  const file = loaded.sourceFiles.find((f) => f.fileName.endsWith('access-registrations.ts'))!;
  accessResources(ctx, [file], []);
  const errors = ctx.diagnostics.filter((d) => d.code === 'AUTHZ012');

  it('reports a second registration with other options as an error, where authz-orm throws', () => {
    expect(errors.map((d) => [d.severity, d.source?.line, d.message])).to.deep.equal([
      ['error', 25, `Other is already registered as resource 'other' ${REFUSED}`],
      ['error', 26, `Decorated is already registered as resource 'decorated' ${REFUSED}`],
      ['error', 45, `Partial is already registered as resource 'partial' ${REFUSED}`],
    ]);
  });

  it('accepts the same options in another order, and does not compare a registration it cannot read', () => {
    expect(errors.filter((d) => d.message.startsWith('Same '))).to.deep.equal([]);
  });

  it('does not compare options behind a spread it cannot read or in a let, which may be reassigned', () => {
    expect(errors.filter((d) => d.source?.line === 33 || d.source?.line === 34)).to.deep.equal([]);
  });
});
