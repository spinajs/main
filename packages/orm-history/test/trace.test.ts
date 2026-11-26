import { AsyncLocalStorage } from 'node:async_hooks';
import { expect } from 'chai';
import 'mocha';
import { AuditContext } from '@spinajs/audit';
import { TestAuditContext } from '@spinajs/audit/testing';
import { DI } from '@spinajs/di';

import { registerHistory } from '../src/index.js';
import { HistoryDb } from './support/db.js';

const TRACE = '0af7651916cd43dd8448eb211c80319c';

describe('the trace id of a history entry', function () {
  this.timeout(60000);
  let db: HistoryDb;

  before(async () => {
    db = await HistoryDb.open();
  });

  after(async () => {
    await db?.close();
  });

  afterEach(async () => {
    await db.clear();
  });

  // http puts `traceId` on the request store, and the authz decision log records the id it reads from the same key
  // (authz/src/host/storage.ts): a tracked write and a check of one request carry one id.
  it('is the trace id of the request store the write ran in', async () => {
    const Invoice = await db.define({ name: 'Invoice', table: 'invoice', columns: { status: 'TEXT' }, decorate: (c) => registerHistory(c) }, 'sqlite');
    // The other suites answer the actor through TestAuditContext. With no AuditContext registered the audit service
    // uses the ambient one, as an application does; the uncache drops the instance the container already holds.
    DI.unregister(AuditContext, TestAuditContext);
    DI.uncache(AuditContext);
    try {
      const store = DI.resolve<AsyncLocalStorage<Record<string, unknown>>>(AsyncLocalStorage);
      await store.run({ traceId: TRACE }, () => Invoice.insert({ id: 'i1', status: 'draft' }));
      await Invoice.insert({ id: 'i2', status: 'draft' });
    } finally {
      DI.register(TestAuditContext).as(AuditContext);
      DI.uncache(AuditContext);
    }

    expect((await db.rows('orm_history', 'sqlite')).map((r) => [r.subject_id, r.trace_id])).to.deep.eq([
      ['i1', TRACE],
      ['i2', null],
    ]);
  });
});
