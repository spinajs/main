import { expect } from 'chai';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { analyzePackage } from '../src/index.js';

describe('analyzePackage', () => {
  it('emits a fragment with every section, sorted by source, and matches the snapshot', async () => {
    const fragment = await analyzePackage({ tsconfig: 'test/fixtures/pkg-basic/tsconfig.json', packageRoot: 'test/fixtures/pkg-basic' });
    expect(fragment.manifestVersion).to.equal(1);
    expect(fragment.package).to.deep.equal({ name: 'pkg-basic', version: '1.0.0', entry: 'lib/index.js', outDir: 'lib' });
    expect(fragment.controllers).to.have.length(1);
    expect(fragment.socketControllers).to.have.length(1);
    expect(fragment.socketContracts).to.have.length(1);
    expect(fragment.configModules).to.have.length(1);
    expect(fragment.models).to.have.length(3);
    expect(fragment.migrations).to.have.length(1);
    expect(fragment.schedules).to.have.length(1);
    expect(fragment.commands).to.have.length(2);
    expect(fragment.queueMessages).to.have.length(2);
    expect(fragment.diagnostics.filter((d) => d.severity === 'error')).to.deep.equal([]);
    const sources = fragment.services.map((s) => s.source);
    const sorted = [...sources].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col);
    expect(sources).to.deep.equal(sorted);
    const snapshot = 'test/__snapshots__/pkg-basic.fragment.json';
    if (!existsSync(snapshot) || process.env.UPDATE_SNAPSHOTS) writeFileSync(snapshot, JSON.stringify(fragment, null, 2) + '\n');
    expect(fragment).to.deep.equal(JSON.parse(readFileSync(snapshot, 'utf8')));
  });
});
