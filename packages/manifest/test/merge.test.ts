import { expect } from 'chai';
import 'mocha';
import { hashManifest, mergeFragments } from '../src/index.js';
import type { Manifest } from '../src/index.js';
import { controller, fragment, route, service, src } from './support.js';

const meta = (names: string[]): { app: Manifest['app']; packages: Manifest['packages']; generatedAt: string } => ({
  app: { name: 'app', version: '1.0.0', root: '.', outDir: 'lib' },
  packages: names.map((name) => ({ name, version: '1.0.0', entry: 'lib/index.js', outDir: 'lib', fragment: `${name}/lib/manifest.fragment.json` })),
  generatedAt: '2026-01-01T00:00:00.000Z',
});

describe('mergeFragments', () => {
  it('prefixes ids with package names and concatenates arrays', () => {
    const app = fragment('app', { services: [service('app', 'A')] });
    const dep = fragment('dep', { services: [service('dep', 'B')] });
    const m = mergeFragments(app, [dep], meta(['dep', 'app']));
    expect(m.services.map((s) => s.id)).to.have.members(['app:A', 'dep:B']);
  });

  it('does not double-prefix ids that already carry the package', () => {
    const s = { ...service('dep', 'B'), id: 'dep:B' };
    const m = mergeFragments(fragment('app'), [fragment('dep', { services: [s] })], meta(['dep', 'app']));
    expect(m.services[0].id).to.equal('dep:B');
  });

  it('keeps fullPath as the fragment recorded it', () => {
    const app = fragment('app', { controllers: [controller('app', 'C', '/users', [route('/x', '//users//x'), route('', '/users/h')])] });
    const m = mergeFragments(app, [], meta(['app']));
    expect(m.controllers[0].routes.map((r) => r.fullPath)).to.deep.equal(['//users//x', '/users/h']);
  });

  it('reports duplicate registeredAs across packages as info', () => {
    const app = fragment('app', { services: [service('app', 'Mine', ['Log'])] });
    const dep = fragment('dep', { services: [service('dep', 'Theirs', ['Log'])] });
    const m = mergeFragments(app, [dep], meta(['dep', 'app']));
    const d = m.diagnostics.filter((x) => x.code === 'duplicate-registration');
    expect(d).to.have.length(1);
    expect(d[0].severity).to.equal('info');
  });

  it('does not flag the same key registered twice inside one package', () => {
    const app = fragment('app', { services: [service('app', 'A', ['Log']), service('app', 'B', ['Log'])] });
    expect(mergeFragments(app, [], meta(['app'])).diagnostics).to.have.length(0);
  });

  it('copies schemas, including config module schemas', () => {
    const dep = fragment('dep', {
      schemas: { 'dep.config': { type: 'object' } },
      configModules: [{ module: 'dep', schemaId: 'dep.config', source: src('dep') }],
    });
    const m = mergeFragments(fragment('app', { schemas: { Dto: { type: 'string' } } }), [dep], meta(['dep', 'app']));
    expect(Object.keys(m.schemas)).to.have.members(['dep.config', 'Dto']);
    expect(m.configModules).to.have.length(1);
  });

  it('emits schema-id-collision when the same $id has different content', () => {
    const a = fragment('app', { schemas: { Dto: { type: 'string' } } });
    const b = fragment('dep', { schemas: { Dto: { type: 'number' } } });
    const m = mergeFragments(a, [b], meta(['dep', 'app']));
    const d = m.diagnostics.filter((x) => x.code === 'schema-id-collision');
    expect(d).to.have.length(1);
    expect(d[0].severity).to.equal('error');
  });

  it('accepts identical schemas under the same $id', () => {
    const a = fragment('app', { schemas: { Dto: { type: 'string' } } });
    const b = fragment('dep', { schemas: { Dto: { type: 'string' } } });
    expect(mergeFragments(a, [b], meta(['dep', 'app'])).diagnostics).to.have.length(0);
  });

  it('keeps fragment diagnostics and stamps app, packages and hash', () => {
    const dep = fragment('dep', { diagnostics: [{ code: 'X', severity: 'warning', message: 'm' }] });
    const m = mergeFragments(fragment('app'), [dep], meta(['dep', 'app']));
    expect(m.manifestVersion).to.equal(2);
    expect(m.app.name).to.equal('app');
    expect(m.packages).to.have.length(2);
    expect(m.diagnostics.map((x) => x.code)).to.deep.equal(['X']);
    expect(m.hash).to.equal(hashManifest(m));
  });

  it('does not mutate its inputs', () => {
    const app = fragment('app', { controllers: [controller('app', 'C', '/a', [route('/b')])] });
    const before = JSON.stringify(app);
    mergeFragments(app, [], meta(['app']));
    expect(JSON.stringify(app)).to.equal(before);
  });
});
