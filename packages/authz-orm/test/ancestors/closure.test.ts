import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';

import { closeOver } from '../../src/ancestors/closure.js';
import type { Link } from '../../src/ancestors/closure.js';

const expect = chai.expect;
const r = (s: string): ResourceRef => ({ type: s.split(':')[0], id: s.split(':')[1] });
const show = (m: Map<string, Link[]>) => Object.fromEntries([...m].map(([k, v]) => [k, v.map((l) => `${l.type}:${l.id}@${l.depth}`)]));

describe('closeOver', () => {
  it('walks parents in the node set and reads the rest from `outside`', () => {
    const out = closeOver(
      [r('task:1'), r('project:p')],
      new Map([
        ['task:1', [r('project:p')]],
        ['project:p', [r('org:o')]],
      ]),
      new Map([['org:o', [{ type: 'tenant', id: 't', depth: 1 }]]]),
    );
    expect(show(out)).to.deep.equal({ 'task:1': ['project:p@1', 'org:o@2', 'tenant:t@3'], 'project:p': ['org:o@1', 'tenant:t@2'] });
  });

  it('keeps the smallest depth when two parent chains meet, sorted by depth then key', () => {
    const out = closeOver(
      [r('task:1')],
      new Map([['task:1', [r('project:p'), r('sprint:s')]]]),
      new Map([
        ['project:p', [{ type: 'org', id: 'o', depth: 1 }]],
        [
          'sprint:s',
          [
            { type: 'board', id: 'b', depth: 1 },
            { type: 'org', id: 'o', depth: 2 },
          ],
        ],
      ]),
    );
    expect(show(out)['task:1']).to.deep.equal(['project:p@1', 'sprint:s@1', 'board:b@2', 'org:o@2']);
  });

  it('skips parents that are gone, which makes their children roots', () => {
    const out = closeOver([r('task:1')], new Map([['task:1', [r('project:p')]]]), new Map([['project:p', [{ type: 'org', id: 'o', depth: 1 }]]]), new Set(['project:p']));
    expect(show(out)).to.deep.equal({ 'task:1': [] });
  });

  it('refuses a cycle, including a self-parent', () => {
    expect(() =>
      closeOver(
        [r('folder:a'), r('folder:b')],
        new Map([
          ['folder:a', [r('folder:b')]],
          ['folder:b', [r('folder:a')]],
        ]),
        new Map(),
      ),
    ).to.throw(AuthzConfigError, /cycle/);
    expect(() => closeOver([r('folder:a')], new Map([['folder:a', [r('folder:a')]]]), new Map())).to.throw(AuthzConfigError, /cycle/);
  });
});
