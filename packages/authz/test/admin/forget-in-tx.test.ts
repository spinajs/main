import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError, AuthzContributor, GLOBAL, MemoryScopeAttributeStore, SYSTEM, ScopeAttributeStore, ScopeForgetter, WritableScopeAttributeStore, adminActor, adminContainer, forgetScopesInTx, memoryTx } from '@spinajs/authz';
import type { AdminContext, AuthzEvent, AuthzTx, ResourceRef } from '@spinajs/authz';
import { adminConfig, adminDomain, installHost, instance, rejection, resetHost, uninstallHost } from './support.js';
import type { AdminDomain } from './support.js';

const expect = chai.expect;

const p1: ResourceRef = { type: 'project', id: 'p1' };
const p2: ResourceRef = { type: 'project', id: 'p2' };
const DELETED = { actor: SYSTEM, reason: 'resource-deleted' };

/** Rows per scope key; forget removes the rows AT the scope, undoable. */
class RowForgetter extends ScopeForgetter {
  readonly rows = new Map<string, string[]>([
    ['project:p1', ['r1', 'r2']],
    ['project:p2', ['r3']],
  ]);
  readonly seen: { scope: ResourceRef; ctx: AdminContext }[] = [];

  async forget(scope: ResourceRef, ctx: AdminContext, tx: AuthzTx): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    this.seen.push({ scope, ctx });
    const key = `${scope.type}:${scope.id}`;
    const gone = this.rows.get(key) ?? [];
    this.rows.delete(key);
    memoryTx(tx).onRollback(() => this.rows.set(key, gone));
    return { affected: gone.length, tags: gone.map((r) => `rule:${r}`), events: [] };
  }
}

const SCHEMA = { scopeType: 'project', schema: { type: 'object' }, defaults: {} };

async function domain(forgetter: RowForgetter, store?: MemoryScopeAttributeStore): Promise<AdminDomain> {
  return adminDomain('test', {
    register(c) {
      c.register(instance(forgetter)).as(ScopeForgetter);
      if (store) {
        c.register(instance(store)).as(ScopeAttributeStore);
        c.register(instance(store)).as(WritableScopeAttributeStore);
        c.register(instance({ contribute: () => ({ scopeAttributeSchemas: [SCHEMA] }) })).as(AuthzContributor);
      }
    },
  });
}

describe('forgetScopesInTx', function () {
  this.timeout(10000);

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
    adminConfig();
  });

  it('runs the scope.forget fan-out for every scope inside the given transaction, publishing nothing', async () => {
    const forgetter = new RowForgetter();
    const store = new MemoryScopeAttributeStore({ values: [{ scope: p1, attributes: { a: 1 } }] });
    const d = await domain(forgetter, store);
    const out = await d.backend.transaction('test', (tx) => forgetScopesInTx(d.container, [p1, p2], tx, DELETED));
    expect([...out.tags].sort()).to.deep.equal(['rule:r1', 'rule:r2', 'rule:r3', 'scope:project:p1', 'scope:project:p2']);
    expect(forgetter.rows.size).to.equal(0);
    expect(await store.get(p1)).to.deep.equal({});
    expect(d.bus.published).to.deep.equal([]);
    expect(d.sink.events).to.deep.equal([]);
  });

  it('hands the forgetters an admin context of the domain with the actor and the reason', async () => {
    const forgetter = new RowForgetter();
    const d = await domain(forgetter);
    await d.backend.transaction('test', (tx) => forgetScopesInTx(d.container, [p1], tx, DELETED));
    const ctx = forgetter.seen[0].ctx;
    expect(ctx.domain).to.equal('test');
    expect(ctx.reason).to.equal('resource-deleted');
    expect(ctx.now.getTime()).to.equal(d.clock.now().getTime());
    expect(adminActor(ctx)).to.equal(SYSTEM);
    expect(adminContainer(ctx)).to.equal(d.container);
  });

  it('rolls back with the caller transaction', async () => {
    const forgetter = new RowForgetter();
    const d = await domain(forgetter);
    const err = await rejection(
      d.backend.transaction('test', async (tx) => {
        await forgetScopesInTx(d.container, [p1], tx, DELETED);
        throw new Error('the delete failed');
      }),
    );
    expect(err.message).to.equal('the delete failed');
    expect(forgetter.rows.get('project:p1')).to.deep.equal(['r1', 'r2']);
  });

  it('refuses GLOBAL and a ref without an id with AuthzConfigError', async () => {
    const forgetter = new RowForgetter();
    const d = await domain(forgetter);
    for (const scope of [GLOBAL, { type: 'project' }]) {
      const err = await rejection(d.backend.transaction('test', (tx) => forgetScopesInTx(d.container, [scope as ResourceRef], tx, DELETED)));
      expect(err).to.be.instanceOf(AuthzConfigError);
    }
    expect(forgetter.seen).to.deep.equal([]);
  });

  it('forgets nothing for an empty list', async () => {
    const forgetter = new RowForgetter();
    const d = await domain(forgetter);
    expect(await d.backend.transaction('test', (tx) => forgetScopesInTx(d.container, [], tx, DELETED))).to.deep.equal({ tags: [] });
    expect(forgetter.seen).to.deep.equal([]);
  });
});
