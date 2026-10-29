import 'mocha';
import { expect } from 'chai';
import { fragmentStale } from '../../src/doctor/rules/fragment-stale.js';
import { fixture } from './fixture.js';

describe('BLD001 fragment-stale', () => {
  const pkg = (name: string) => ({ name, version: '4.0.0', entry: 'lib/index.js', outDir: 'lib', fragment: `node_modules/${name}/lib/manifest.fragment.json` });
  const m = fixture({ packages: [pkg('@spinajs/fresh'), pkg('@spinajs/stale'), pkg('@spinajs/none'), pkg('@spinajs/source-only')] });
  const times = new Map<string, [number | undefined, number | undefined]>([
    ['@spinajs/fresh', [200, 100]],
    ['@spinajs/stale', [100, 200]],
    ['@spinajs/none', [undefined, 50]],
    ['@spinajs/source-only', [100, undefined]],
  ]);
  const ctx = { cwd: '/fixture', fileExists: () => true, fragmentMtime: (p: string) => times.get(p)?.[0], libMtime: (p: string) => times.get(p)?.[1] };

  it('reports fragments older than lib and missing fragments', () => {
    expect(fragmentStale.run(m, ctx)).to.deep.equal([
      { code: 'BLD001', severity: 'error', message: 'Fragment of @spinajs/stale is older than its build output; run npm run build' },
      { code: 'BLD001', severity: 'error', message: 'Fragment of @spinajs/none is missing at node_modules/@spinajs/none/lib/manifest.fragment.json' },
    ]);
  });
});
