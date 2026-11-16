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
      { section: 'workflows', kind: 'changed', id: 'order@2', breaking: false, detail: 'signals changed' },
      { section: 'workflows', kind: 'added', id: 'order@3', breaking: false },
    ]);
    expect(diffManifest(base, head).breaking).to.equal(true);
  });

  it('diff: signal order is no change; a removed signal or a new permission on one breaks its senders', () => {
    const rows = (before: Partial<WorkflowEntry>, after: Partial<WorkflowEntry>) =>
      diffManifest(mergeFragments(fragment('app', { workflows: [wf('order', 1, before)] }), [], meta), mergeFragments(fragment('app', { workflows: [wf('order', 1, after)] }), [], meta)).changes.map(
        (c) => [c.detail, c.breaking],
      );
    const a = { name: 'a' };
    const b = { name: 'b' };
    expect(rows({ signals: [a, b] }, { signals: [b, a] })).to.deep.equal([]);
    expect(rows({ className: 'Old' }, { className: 'New' })).to.deep.equal([['class changed', false]]);
    expect(rows({ className: 'Old', signals: [a] }, { className: 'New', signals: [a, b] })).to.deep.equal([['class changed; signals changed', false]]);
    expect(rows({ signals: [a, b] }, { signals: [a] })).to.deep.equal([['signals changed', true]]);
    expect(rows({ signals: [a] }, { signals: [{ name: 'a', permission: 'p' }] })).to.deep.equal([['signals changed', true]]);
    expect(rows({ signals: [{ name: 'a', permission: 'p' }] }, { signals: [{ name: 'a', permission: 'q' }] })).to.deep.equal([['signals changed', true]]);
    expect(rows({ signals: [{ name: 'a', permission: 'p' }] }, { signals: [a] })).to.deep.equal([['signals changed', false]]);
  });
});
