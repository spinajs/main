import 'mocha';
import { expect } from 'chai';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateConfigDeclarations, leafPaths } from '../../src/index.js';
import type { Manifest } from '@spinajs/manifest';

const manifestPath = fileURLToPath(new URL('../fixtures/app-basic/app.manifest.json', import.meta.url));
const snapshotPath = fileURLToPath(new URL('../__snapshots__/app-basic.config.d.ts', import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;

describe('generateConfigDeclarations', () => {
  it('flattens schemas into leaf and node paths', () => {
    const paths = leafPaths({ type: 'object', properties: { timeoutMs: { type: 'integer' }, nested: { type: 'object', properties: { a: { type: 'string' } } }, __file__: { type: 'string' } } }, 'hooks');
    expect(paths.map((p) => p.path)).to.deep.equal(['hooks.timeoutMs', 'hooks.nested', 'hooks.nested.a']);
  });

  it('matches the committed snapshot and declares hooks.timeoutMs as number', async () => {
    const source = await generateConfigDeclarations(manifest);
    if (!existsSync(snapshotPath)) writeFileSync(snapshotPath, source);
    expect(source).to.equal(readFileSync(snapshotPath, 'utf8'));
    expect(source).to.include(`'hooks.timeoutMs': number;`);
    expect(source).to.include(`'app.name': string;`);
    expect(source).to.match(/declare module '@spinajs\/configuration-common' \{\s+interface ConfigPaths \{/);
  });

  it('restricts to the requested modules and is deterministic', async () => {
    const only = await generateConfigDeclarations(manifest, { modules: ['hooks'] });
    expect(only).to.include(`'hooks.maxDepth': number;`);
    expect(only).to.not.include(`'app.name'`);
    expect(await generateConfigDeclarations(manifest, { modules: ['hooks'] })).to.equal(only);
  });
});
