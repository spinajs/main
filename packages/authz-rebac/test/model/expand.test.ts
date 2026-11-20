import { expect } from 'chai';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';

import { CAVEAT_TUPLES, caveatModel } from '../support/caveat-world.js';
import { d1, d2, d3, f0, f1, ref, set, setup, tuple, user } from '../support/world.js';

const USERS = ['alice', 'bob', 'carol', 'frank', 'olga', 'zed'];
const ids = (out: { subjects: readonly { id: string }[] }) => out.subjects.map((s) => s.id);

describe('RebacModel.listSubjects', () => {
  it('follows subject sets, arrows and the set operations', async () => {
    const { model } = await setup();
    expect(ids(await model.listSubjects(d1, 'read', 'user'))).to.deep.equal(['alice', 'bob', 'olga']);
    expect(ids(await model.listSubjects(d1, 'edit', 'user'))).to.deep.equal(['alice']);
    expect(ids(await model.listSubjects(d1, 'view', 'user'))).to.deep.equal(['alice', 'olga']);
    expect(ids(await model.listSubjects(d2, 'read', 'user'))).to.deep.equal(['carol', 'frank']);
    expect(ids(await model.listSubjects(ref('group', 'eng'), 'member', 'group'))).to.deep.equal([]);
  });

  it('agrees with check() for every user and permission', async () => {
    const { model } = await setup();
    for (const object of [d1, d2]) {
      for (const name of ['read', 'edit', 'view']) {
        const listed = ids(await model.listSubjects(object, name, 'user'));
        const held = [];
        for (const u of USERS) if ((await model.check(object, name, user(u))) === 'member') held.push(u);
        expect(listed, `${object.id}#${name}`).to.deep.equal(held);
      }
    }
  });

  it('a cycle of subject sets ends the walk; a cut at maxDepth makes the list incomplete', async () => {
    const { model } = await setup();
    expect(await model.listSubjects(d3, 'read', 'user')).to.deep.equal({ subjects: [], conditional: [], complete: true });
    const shallow = await setup({ limit: { maxDepth: 1 } });
    expect((await shallow.model.listSubjects(d2, 'read', 'user')).complete).to.equal(false);
  });

  it('refuses a name the namespaces do not know', async () => {
    const { model } = await setup();
    expect(() => model.listSubjects(d1, 'nope', 'user')).to.throw(AuthzConfigError, /doc#nope/);
    expect(() => model.expand(ref('nope', 'x'), 'read')).to.throw(AuthzConfigError);
  });
});

describe('RebacModel.expand', () => {
  it('gives the rewrite as a tree, stored subjects at the leaves, subject sets not followed', async () => {
    const { model } = await setup();
    expect(await model.expand(d1, 'edit')).to.deep.equal({
      kind: 'intersection',
      children: [
        { kind: 'computed', object: d1, relation: 'editor', child: { kind: 'tuples', object: d1, relation: 'editor', subjects: [user('alice'), user('bob')] } },
        { kind: 'computed', object: d1, relation: 'approved', child: { kind: 'tuples', object: d1, relation: 'approved', subjects: [user('alice')] } },
      ],
    });
    const viewers = await model.expand(d1, 'viewer');
    expect(viewers).to.deep.equal({ kind: 'tuples', object: d1, relation: 'viewer', subjects: [{ object: ref('group', 'eng'), relation: 'member' }] });
  });

  it('expands arrows one hop at a time; a subject set stays a leaf, even in a cycle', async () => {
    const { model } = await setup();
    const tree = await model.expand(ref('folder', 'f1'), 'view');
    if (tree.kind !== 'union') expect.fail(`expected a union, got ${tree.kind}`);
    const arrow = tree.children[1];
    if (arrow.kind !== 'tupleToUserset') expect.fail(`expected an arrow, got ${arrow.kind}`);
    expect(arrow.children.map((c) => c.kind)).to.deep.equal(['union']);
    expect(arrow.children[0]).to.deep.include({ kind: 'union' });
    const looped = await model.expand(ref('group', 'a'), 'member');
    expect(looped).to.deep.equal({ kind: 'tuples', object: ref('group', 'a'), relation: 'member', subjects: [{ object: ref('group', 'b'), relation: 'member' }] });
  });

  it('marks the branches past maxDepth truncated', async () => {
    const { model } = await setup({ limit: { maxDepth: 1 } });
    const tree = await model.expand(f1, 'view');
    if (tree.kind !== 'union') expect.fail(`expected a union, got ${tree.kind}`);
    expect(tree.children[1]).to.deep.equal({
      kind: 'tupleToUserset',
      object: f1,
      tupleset: 'parent',
      computed: 'view',
      children: [
        {
          kind: 'union',
          children: [
            { kind: 'computed', object: f0, relation: 'viewer', child: { kind: 'tuples', object: f0, relation: 'viewer', subjects: [user('carol')] } },
            { kind: 'tupleToUserset', object: f0, tupleset: 'parent', computed: 'view', children: [] },
          ],
        },
      ],
    });
    const deeper = await model.expand(d2, 'read');
    expect(JSON.stringify(deeper)).to.contain(JSON.stringify({ kind: 'truncated', object: f0, relation: 'view' }));
  });
});

describe('expand and listSubjects with conditional tuples', () => {
  const ip = { name: 'office_ip' };

  it('expand lists conditional subjects apart and wraps an arrow through a conditional tuple', async () => {
    const model = await caveatModel();
    expect(await model.expand(d1, 'viewer')).to.deep.equal({ kind: 'tuples', object: d1, relation: 'viewer', subjects: [], conditional: [{ subject: user('bob'), caveat: ip }, { subject: set('group', 'eng', 'member'), caveat: ip }] });
    const read = await model.expand(d2, 'read');
    const caveat = { name: 'not_expired', context: { 'env.until': 20 } };
    if (read.kind !== 'union') throw new Error('expected a union');
    expect(read.children[1]).to.deep.equal({ kind: 'tupleToUserset', object: d2, tupleset: 'parent', computed: 'view', children: [{ kind: 'caveat', caveat, child: await model.expand(f1, 'view') }] });
  });

  it('listSubjects decides caveats against a request; without one their holders are conditional', async () => {
    const model = await caveatModel();
    expect(await model.listSubjects(d1, 'read', 'user')).to.deep.equal({ subjects: [], conditional: [user('bob'), user('carl')], complete: true });
    expect(await model.listSubjects(d1, 'read', 'user', { env: { ip: '10.0.0.1' } })).to.deep.equal({ subjects: [user('bob'), user('carl')], conditional: [], complete: true });
    expect(await model.listSubjects(d1, 'read', 'user', { env: { ip: '10.0.0.2' } })).to.deep.equal({ subjects: [], conditional: [], complete: true });
    expect((await model.listSubjects(d2, 'read', 'user', { env: { day: 10 } })).subjects).to.deep.equal([user('dora')]);
  });

  it('an exclusion keeps a holder for certain only when no caveat could subtract it', async () => {
    const model = await caveatModel([...CAVEAT_TUPLES, tuple(d1, 'viewer', user('erin')), { ...tuple(d1, 'banned', user('bob')), caveat: ip }]);
    expect(await model.listSubjects(d1, 'blocked_read', 'user')).to.deep.equal({ subjects: [user('erin')], conditional: [user('bob'), user('carl')], complete: true });
    expect(await model.listSubjects(d1, 'blocked_read', 'user', { env: { ip: '10.0.0.1' } })).to.deep.equal({ subjects: [user('carl'), user('erin')], conditional: [], complete: true });
  });
});
