import 'mocha';
import { expect } from 'chai';
import type { Diagnostic, Manifest } from '@spinajs/manifest';
import { flowSystemWithoutReason, flowUnscopedRead, flowUnscopedWrite } from '../../src/doctor/rules/index.js';
import { fixture, src } from './fixture.js';

const ctx = { cwd: '/fixture', fileExists: () => true, fragmentMtime: () => undefined, libMtime: () => undefined };
const APP = { name: 'app', version: '0.0.0', root: '/fixture', outDir: 'lib' };
type Ignore = NonNullable<Manifest['authz']>['ignores'][number];
const finding = (code: string, message: string, line: number, pkg = 'app'): Diagnostic => ({ code, severity: 'warning', message, source: src('src/services.ts', line, pkg) });

function manifest(ignores: Ignore[] = [{ code: 'AUTHZ001', reason: 'export reads all', source: src('src/services.ts', 9) }]): Manifest {
  return fixture({
    app: APP,
    authz: {
      resources: [],
      permissions: [],
      entryPoints: [],
      findings: [finding('AUTHZ001', 'ignored', 10), finding('AUTHZ001', 'reported', 20), finding('AUTHZ001', 'of a dependency', 20, '@x/lib'), finding('AUTHZ002', 'write', 30), finding('AUTHZ006', 'system', 40)],
      ignores,
      flow: { entryPoints: 3, unresolvedRoots: 0, opaqueCalls: 0, externalCalls: 0, foreignModelQueries: 0 },
    },
  });
}

describe('doctor: flow findings', () => {
  it('reports each code through its own rule, the app package only, and honours an ignore comment on the line above', () => {
    expect(flowUnscopedRead.run(manifest(), ctx).map((d) => d.message)).to.deep.equal(['reported']);
    expect(flowUnscopedWrite.run(manifest(), ctx).map((d) => [d.code, d.message])).to.deep.equal([['AUTHZ002', 'write']]);
    expect(flowSystemWithoutReason.run(manifest(), ctx).map((d) => [d.code, d.message])).to.deep.equal([['AUTHZ006', 'system']]);
  });

  it('keeps a finding an ignore of another code, of another file or two lines above names', () => {
    const m = manifest([
      { code: 'AUTHZ002', reason: 'other code', source: src('src/services.ts', 20) },
      { code: 'AUTHZ001', reason: 'other file', source: src('src/other.ts', 20) },
      { code: 'AUTHZ001', reason: 'too far', source: src('src/services.ts', 18) },
    ]);
    expect(flowUnscopedRead.run(m, ctx).map((d) => d.message)).to.deep.equal(['ignored', 'reported']);
  });

  it('reports nothing for a manifest without an authz section', () => {
    expect(flowUnscopedRead.run(fixture({ app: APP }), ctx)).to.deep.equal([]);
  });
});
