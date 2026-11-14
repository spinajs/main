import { expect } from 'chai';
import 'mocha';
import { hashManifest, mergeFragments, validateFragment } from '../src/index.js';
import type { AuthzSection, Manifest, ModelEntry } from '../src/index.js';
import { fragment, src } from './support.js';

const meta = (names: string[]): { app: Manifest['app']; packages: Manifest['packages']; generatedAt: string } => ({
  app: { name: 'app', version: '1.0.0', root: '.', outDir: 'lib' },
  packages: names.map((name) => ({ name, version: '1.0.0', entry: 'lib/index.js', outDir: 'lib', fragment: `${name}/lib/manifest.fragment.json` })),
  generatedAt: '2026-01-01T00:00:00.000Z',
});

const model = (pkg: string, className: string, accessResource?: string): ModelEntry => ({
  id: `${pkg}:${className}`, className, tableName: className.toLowerCase(), columns: [], relations: [], ...(accessResource ? { accessResource } : {}), source: src(pkg),
});

const section = (over: Partial<AuthzSection> = {}): AuthzSection => ({ resources: [], permissions: [], entryPoints: [], findings: [], ignores: [], ...over });

describe('manifest authz section', () => {
  it('validates a fragment with an authz section and a typed access resource', () => {
    const authz = section({
      resources: [{ type: 'post', model: 'app:Post', relations: [{ name: 'parent', kind: 'parent', column: 'BlogId', target: 'blog' }], source: src() }],
      permissions: [{ name: 'post:read', declaredIn: 'model' }],
      entryPoints: [{ kind: 'socket-command', id: 'docs.open', access: [[{ type: 'AccessPolicy', options: ['doc:read'] }]], source: src() }],
      ignores: [{ code: 'AUTHZ001', reason: 'admin report', source: src() }],
    });
    expect(validateFragment(fragment('app', { models: [model('app', 'Post', 'post')], authz }))).to.deep.equal([]);
  });

  it('rejects the boolean accessResource of fragments older than the type string', () => {
    const old = { ...model('app', 'Post'), accessResource: true } as unknown as ModelEntry;
    expect(validateFragment(fragment('app', { models: [old] }))).to.not.deep.equal([]);
  });

  it('has no authz section when no fragment declares one', () => {
    expect(mergeFragments(fragment('app'), [fragment('dep')], meta(['dep', 'app']))).to.not.have.property('authz');
  });

  it('concatenates the sections of every fragment, dependencies first', () => {
    const dep = fragment('dep', { authz: section({ permissions: [{ name: 'job:read', declaredIn: 'model' }], ignores: [{ code: 'AUTHZ001', reason: 'r', source: src('dep') }] }) });
    const app = fragment('app', { authz: section({ permissions: [{ name: 'post:read', declaredIn: 'model' }], entryPoints: [{ kind: 'schedule', id: 'nightly', access: [], system: 'sweep', source: src() }] }) });
    const { authz } = mergeFragments(app, [dep, fragment('plain')], meta(['dep', 'plain', 'app']));
    expect(authz?.permissions.map((p) => p.name)).to.deep.equal(['job:read', 'post:read']);
    expect(authz?.entryPoints.map((e) => e.id)).to.deep.equal(['nightly']);
    expect(authz?.ignores.map((i) => i.source.package)).to.deep.equal(['dep']);
    expect(authz).to.not.have.property('ir');
    expect(authz).to.not.have.property('policyHash');
  });

  it('marks a dependency model an access resource when another package registers it', () => {
    const dep = fragment('dep', { models: [model('dep', 'JobModel'), model('dep', 'Other')] });
    const app = fragment('app', { authz: section({ resources: [{ type: 'job', model: 'dep:JobModel', relations: [], source: src() }] }) });
    const m = mergeFragments(app, [dep], meta(['dep', 'app']));
    expect(m.models.map((x) => [x.id, x.accessResource])).to.deep.equal([['dep:JobModel', 'job'], ['dep:Other', undefined]]);
  });

  it('covers the authz section in the hash', () => {
    const build = (name: string) => mergeFragments(fragment('app', { authz: section({ permissions: [{ name, declaredIn: 'model' }] }) }), [], meta(['app']));
    expect(hashManifest(build('post:read'))).to.not.equal(hashManifest(build('post:update')));
  });
});
