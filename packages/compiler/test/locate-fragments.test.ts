import { expect } from 'chai';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { locateFragments } from '../src/index.js';

const WS = 'test/fixtures/.tmp-ws';
const CLOSURE = 'test/fixtures/.tmp-closure';

const write = (file: string, content: unknown) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(content));
};

const withFragment = (pkg: object) => ({ version: '1.0.0', spinajs: { manifest: 'lib/manifest.fragment.json' }, ...pkg });

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

describe('locateFragments over the dependency closure', () => {
  const nm = `${CLOSURE}/node_modules`;
  const fragment = (dir: string) => write(`${dir}/lib/manifest.fragment.json`, {});

  before(() => {
    rmSync(CLOSURE, { recursive: true, force: true });
    write(`${CLOSURE}/app/package.json`, { name: 'app', version: '1.0.0', dependencies: { plain: '1.0.0' }, optionalDependencies: { 'not-installed': '1.0.0' }, devDependencies: { '@spinajs/dev-tool': '1.0.0' } });
    // a package without a fragment is walked through
    write(`${nm}/plain/package.json`, { name: 'plain', version: '1.0.0', dependencies: { '@spinajs/mid': '1.0.0' } });
    write(`${nm}/@spinajs/mid/package.json`, withFragment({ name: '@spinajs/mid', dependencies: { '@spinajs/leaf': '1.0.0' }, peerDependencies: { '@spinajs/peer': '1.0.0', 'missing-peer': '1.0.0' } }));
    fragment(`${nm}/@spinajs/mid`);
    // the cycle back to mid ends the walk
    write(`${nm}/@spinajs/leaf/package.json`, withFragment({ name: '@spinajs/leaf', dependencies: { '@spinajs/mid': '1.0.0', app: '1.0.0' } }));
    fragment(`${nm}/@spinajs/leaf`);
    write(`${nm}/@spinajs/peer/package.json`, withFragment({ name: '@spinajs/peer', optionalDependencies: { '@spinajs/opt': '1.0.0' } }));
    fragment(`${nm}/@spinajs/peer`);
    // installed next to its dependent only: the walk resolves it there, and its own dependencies are followed
    write(`${nm}/@spinajs/peer/node_modules/@spinajs/opt/package.json`, withFragment({ name: '@spinajs/opt', dependencies: { '@spinajs/deep': '1.0.0' } }));
    fragment(`${nm}/@spinajs/peer/node_modules/@spinajs/opt`);
    write(`${nm}/@spinajs/deep/package.json`, withFragment({ name: '@spinajs/deep' }));
    fragment(`${nm}/@spinajs/deep`);
    // a devDependency of the app is followed, its own dependencies too; a dependency's devDependencies are not
    write(`${nm}/@spinajs/dev-tool/package.json`, withFragment({ name: '@spinajs/dev-tool', dependencies: { '@spinajs/dev-leaf': '1.0.0' }, devDependencies: { '@spinajs/unused': '1.0.0' } }));
    fragment(`${nm}/@spinajs/dev-tool`);
    write(`${nm}/@spinajs/dev-leaf/package.json`, withFragment({ name: '@spinajs/dev-leaf' }));
    fragment(`${nm}/@spinajs/dev-leaf`);
    // installed but nothing depends on it
    write(`${nm}/@spinajs/unused/package.json`, withFragment({ name: '@spinajs/unused' }));
    fragment(`${nm}/@spinajs/unused`);
  });

  after(() => {
    rmSync(CLOSURE, { recursive: true, force: true });
  });

  it('lists every transitive package, also those below a devDependency of the app, with a fragment that resolves from the app root, in name order', async () => {
    const found = await locateFragments(`${CLOSURE}/app`);
    expect(found.map((f) => [f.name, f.fragmentRel])).to.deep.equal([
      ['@spinajs/deep', 'node_modules/@spinajs/deep/lib/manifest.fragment.json'],
      ['@spinajs/dev-leaf', 'node_modules/@spinajs/dev-leaf/lib/manifest.fragment.json'],
      ['@spinajs/dev-tool', 'node_modules/@spinajs/dev-tool/lib/manifest.fragment.json'],
      ['@spinajs/leaf', 'node_modules/@spinajs/leaf/lib/manifest.fragment.json'],
      ['@spinajs/mid', 'node_modules/@spinajs/mid/lib/manifest.fragment.json'],
      ['@spinajs/peer', 'node_modules/@spinajs/peer/lib/manifest.fragment.json'],
    ]);
  });
});
