import { expect } from 'chai';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { locateFragments } from '../src/index.js';

const WS = 'test/fixtures/.tmp-ws';

describe('locateFragments in a workspace layout', () => {
  before(() => {
    rmSync(WS, { recursive: true, force: true });
    mkdirSync(`${WS}/node_modules/dep/lib`, { recursive: true });
    mkdirSync(`${WS}/app`, { recursive: true });
    writeFileSync(`${WS}/node_modules/dep/package.json`, JSON.stringify({ name: 'dep', version: '2.0.0', exports: { '.': './lib/index.js' }, spinajs: { manifest: 'lib/manifest.fragment.json' } }));
    writeFileSync(`${WS}/node_modules/dep/lib/manifest.fragment.json`, '{}');
    writeFileSync(`${WS}/app/package.json`, JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { dep: '2.0.0' } }));
  });

  after(() => {
    rmSync(WS, { recursive: true, force: true });
  });

  it('finds a dependency hoisted above the app whose exports hide package.json, with a logical path', async () => {
    const found = await locateFragments(`${WS}/app`);
    expect(found.map((f) => [f.name, f.fragmentRel])).to.deep.equal([['dep', 'node_modules/dep/lib/manifest.fragment.json']]);
  });
});
