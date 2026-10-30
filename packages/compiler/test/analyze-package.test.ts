import { expect } from 'chai';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { analyzePackage } from '../src/index.js';

describe('analyzePackage', () => {
  it('queue events used as route returns and socket payloads share one schema without the framework envelope', async () => {
    const fragment = await analyzePackage({ tsconfig: 'test/fixtures/pkg-basic/tsconfig.json', packageRoot: 'test/fixtures/pkg-basic' });
    const route = fragment.controllers[0].routes.find((r) => r.handler === 'events')!;
    const event = fragment.socketControllers[0].events.find((e) => e.name === 'created')!;
    const queue = fragment.queueMessages.find((m) => m.className === 'UserCreated')!;
    expect(route.returnType.schema).to.equal('spinajs/pkg-basic/UserCreated');
    expect(event.payload.schema).to.equal(route.returnType.schema);
    expect(queue.payload.schema).to.equal(route.returnType.schema);
    expect(Object.keys((fragment.schemas['spinajs/pkg-basic/UserCreated'] as { properties: object }).properties)).to.deep.equal(['userId', 'email']);
  });

  it('emits a fragment with every section, sorted by source, and matches the snapshot', async () => {
    const fragment = await analyzePackage({ tsconfig: 'test/fixtures/pkg-basic/tsconfig.json', packageRoot: 'test/fixtures/pkg-basic' });
    expect(fragment.manifestVersion).to.equal(2);
    expect(fragment.package).to.deep.equal({
      name: 'pkg-basic',
      version: '1.0.0',
      entry: 'lib/index.js',
      outDir: 'lib',
      configFiles: ['config/basic.js', 'config/basic.production.js', 'config/nested/extra.js'],
    });
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
    const files = [...JSON.stringify(fragment).matchAll(/"file":"([^"]*)"/g)].map((m) => m[1]);
    expect(files.length).to.be.greaterThan(0);
    expect(files.filter((f) => f.startsWith('..') || f.includes('node_modules'))).to.deep.equal([]);
    const snapshot = 'test/__snapshots__/pkg-basic.fragment.json';
    if (!existsSync(snapshot) || process.env.UPDATE_SNAPSHOTS) writeFileSync(snapshot, JSON.stringify(fragment, null, 2) + '\n');
    expect(fragment).to.deep.equal(JSON.parse(readFileSync(snapshot, 'utf8')));
  });
});
