import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError, MemoryAuthzAdminBackend, memoryTx } from '@spinajs/authz';
import type { AuthzCommandResult, AuthzTx } from '@spinajs/authz';

const expect = chai.expect;

const T0 = new Date('2026-10-03T00:00:00.000Z');
const later = (ms: number) => new Date(T0.getTime() + ms);
const RESULTS: readonly AuthzCommandResult[] = [{ ok: true, kind: 'assignment.grant', id: 'a1', affected: 1 }];

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}

describe('MemoryAuthzAdminBackend', () => {
  it('returns what the transaction returns and runs no undo on commit', async () => {
    const b = new MemoryAuthzAdminBackend();
    const undone: string[] = [];
    const out = await b.transaction('d', async (tx) => {
      memoryTx(tx).onRollback(() => undone.push('x'));
      return 7;
    });
    expect(out).to.equal(7);
    expect(undone).to.deep.equal([]);
  });

  it('runs the undo functions in reverse order on rollback and rethrows', async () => {
    const b = new MemoryAuthzAdminBackend();
    const undone: string[] = [];
    const boom = new Error('boom');
    const err = await rejection(
      b.transaction('d', async (tx) => {
        memoryTx(tx).onRollback(() => undone.push('first'));
        memoryTx(tx).onRollback(() => {
          undone.push('second');
          throw new Error('undo failed');
        });
        memoryTx(tx).onRollback(() => undone.push('third'));
        throw boom;
      }),
    );
    expect(err).to.equal(boom);
    expect(undone).to.deep.equal(['third', 'second', 'first']);
  });

  it('runs transactions one at a time, also after a failed one', async () => {
    const b = new MemoryAuthzAdminBackend();
    const log: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const t1 = b.transaction('d', async () => {
      log.push('t1 start');
      await gate;
      log.push('t1 end');
      throw new Error('t1');
    });
    const t2 = b.transaction('d', async () => {
      log.push('t2');
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(log).to.deep.equal(['t1 start']);
    open();
    await rejection(t1);
    await t2;
    expect(log).to.deep.equal(['t1 start', 't1 end', 't2']);
  });

  it('memoryTx refuses a foreign tx and a finished one', async () => {
    expect(() => memoryTx({ driver: {} })).to.throw(AuthzConfigError);
    expect(() => memoryTx(undefined as unknown as AuthzTx)).to.throw(AuthzConfigError);
    const b = new MemoryAuthzAdminBackend();
    let kept!: AuthzTx;
    await b.transaction('d', async (tx) => {
      kept = tx;
    });
    expect(() => memoryTx(kept).onRollback(() => undefined)).to.throw(AuthzConfigError);
  });

  it('bumps the version per domain and rolls the bump back', async () => {
    const b = new MemoryAuthzAdminBackend();
    await b.transaction('d', (tx) => b.bumpVersion('d', tx));
    await b.transaction('d', (tx) => b.bumpVersion('d', tx));
    await rejection(
      b.transaction('d', async (tx) => {
        await b.bumpVersion('d', tx);
        throw new Error('no');
      }),
    );
    expect(b.version('d')).to.equal(2);
    expect(b.version('other')).to.equal(0);
  });

  it('remembers results by domain, actor and key until they expire', async () => {
    const b = new MemoryAuthzAdminBackend();
    const stored = await b.transaction('d', (tx) => b.remember('d', 'user:alice', 'k', RESULTS, later(1000), tx));
    expect(stored).to.equal('stored');
    const got = await b.recall('d', 'user:alice', 'k', later(999));
    expect(got).to.deep.equal(RESULTS);
    expect(got).to.not.equal(RESULTS);
    expect(await b.recall('d', 'user:bob', 'k', T0)).to.equal(undefined);
    expect(await b.recall('e', 'user:alice', 'k', T0)).to.equal(undefined);
    expect(await b.recall('d', 'user:alice', 'k', later(1000))).to.equal(undefined);
  });

  it('answers exists for a stored key, and stores again once a recall found it expired', async () => {
    const b = new MemoryAuthzAdminBackend();
    await b.transaction('d', (tx) => b.remember('d', 'user:alice', 'k', RESULTS, later(1000), tx));
    expect(await b.transaction('d', (tx) => b.remember('d', 'user:alice', 'k', [], later(2000), tx))).to.equal('exists');
    expect(await b.recall('d', 'user:alice', 'k', later(1000))).to.equal(undefined);
    expect(await b.transaction('d', (tx) => b.remember('d', 'user:alice', 'k', [], later(5000), tx))).to.equal('stored');
    expect(await b.recall('d', 'user:alice', 'k', later(1000))).to.deep.equal([]);
  });

  it('drops a remembered entry when its transaction rolls back', async () => {
    const b = new MemoryAuthzAdminBackend();
    await rejection(
      b.transaction('d', async (tx) => {
        await b.remember('d', 'user:alice', 'k', RESULTS, later(1000), tx);
        throw new Error('no');
      }),
    );
    expect(await b.recall('d', 'user:alice', 'k', T0)).to.equal(undefined);
  });

  it('keeps a copy: changing the caller’s results changes nothing stored', async () => {
    const b = new MemoryAuthzAdminBackend();
    const mine = [{ ok: true, kind: 'assignment.grant', id: 'a1', affected: 1 }] as AuthzCommandResult[];
    await b.transaction('d', (tx) => b.remember('d', 'user:alice', 'k', mine, later(1000), tx));
    (mine[0] as { affected: number }).affected = 99;
    expect(await b.recall('d', 'user:alice', 'k', T0)).to.deep.equal(RESULTS);
  });
});
