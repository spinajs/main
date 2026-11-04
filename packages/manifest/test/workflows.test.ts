import { expect } from 'chai';
import 'mocha';
import { diffManifest, mergeFragments, publishedManifest, validateFragment } from '../src/index.js';
import type { WorkflowEntry } from '../src/index.js';
import { fragment, src } from './support.js';

const wf = (name: string, version: number, extra: Partial<WorkflowEntry> = {}): WorkflowEntry => ({ name, version, className: `${name}V${version}`, signals: [], source: src('app'), ...extra });
const meta = { app: { name: 'app', version: '1.0.0', root: '.', outDir: 'lib' }, packages: [], generatedAt: '2026-11-10T00:00:00.000Z' };

describe('workflows in the manifest', () => {
  it('a fragment with workflows validates, and one without stays valid', () => {
    expect(validateFragment(fragment('app', { workflows: [wf('order', 2, { signals: [{ name: 'approved', permission: 'orders:approve' }, { name: '*' }] })] }))).to.deep.equal([]);
    expect(validateFragment(fragment('app'))).to.deep.equal([]);
  });

  it('merge concatenates workflows, dependencies first, and omits the section when no fragment has any', () => {
    const merged = mergeFragments(fragment('app', { workflows: [wf('order', 2)] }), [fragment('dep', { workflows: [wf('billing', 1)] })], meta);
    expect(merged.workflows?.map((w) => `${w.name}@${w.version}`)).to.deep.equal(['billing@1', 'order@2']);
    expect(mergeFragments(fragment('app'), [], meta)).to.not.have.property('workflows');
  });

  it('the published manifest leaves out workflows only a DI registration mounts', () => {
    const merged = mergeFragments(fragment('app', { workflows: [wf('order', 1), wf('hidden', 1, { mountedBy: 'di' })] }), [], meta);
    expect(publishedManifest(merged).workflows?.map((w) => w.name)).to.deep.equal(['order']);
    expect(publishedManifest(mergeFragments(fragment('app'), [], meta))).to.not.have.property('workflows');
  });

  it('diff: added and removed versions are rows of their own, a removed version is breaking', () => {
    const base = mergeFragments(fragment('app', { workflows: [wf('order', 1), wf('order', 2)] }), [], meta);
    const head = mergeFragments(fragment('app', { workflows: [wf('order', 2, { signals: [{ name: 'approved' }] }), wf('order', 3)] }), [], meta);
    expect(diffManifest(base, head).changes.filter((c) => c.section === 'workflows')).to.deep.equal([
      { section: 'workflows', kind: 'removed', id: 'order@1', breaking: true },
      { section: 'workflows', kind: 'changed', id: 'order@2', breaking: false, detail: 'class or signals changed' },
      { section: 'workflows', kind: 'added', id: 'order@3', breaking: false },
    ]);
    expect(diffManifest(base, head).breaking).to.equal(true);
  });
});
