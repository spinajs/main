/* eslint-disable prettier/prettier */
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { QueryContext, QueryMiddleware } from '@spinajs/orm';
import type { QueryBuilder } from '@spinajs/orm';
import { bootUow, registerUowConnection, rows, UowClient, UowTag } from './uowFixture.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

let asksForTransaction = true;
let failAfter = false;

const isTagWrite = (query: QueryBuilder): boolean => query.Model === UowTag && query.QueryContext !== QueryContext.Select;

/** Writes an audit row after every write to uow_tag, the way authz-orm keeps its closure table. */
class TagAudit extends QueryMiddleware {
  public afterQueryCreation(): void {}

  public beforeQueryExecution(): void {}

  public async afterQueryExecution(query: QueryBuilder): Promise<void> {
    if (!isTagWrite(query)) return;
    if (failAfter) throw new Error('after hook failed');
    await UowClient.insert({ Name: 'audit' });
  }

  public transactional(query: QueryBuilder): boolean {
    return asksForTransaction && isTagWrite(query);
  }
}

describe('query middleware transactions on sqlite', function () {
  this.timeout(10000);

  before(() => {
    registerUowConnection();
    DI.register(TagAudit).as(QueryMiddleware);
  });

  after(() => {
    DI.unregister(TagAudit);
  });

  beforeEach(async () => {
    asksForTransaction = true;
    failAfter = false;
    await bootUow();
  });

  afterEach(() => DI.clearCache());

  it('commits the statement and the after hook write together', async () => {
    await UowTag.insert({ Name: 'red' });

    expect(await rows('uow_tag')).to.have.length(1);
    expect((await rows('uow_client')).map((r) => r.Name)).to.eql(['audit']);
  });

  it('rolls the statement back when the after hook throws', async () => {
    failAfter = true;

    await expect(UowTag.insert({ Name: 'red' })).to.be.rejectedWith('after hook failed');

    expect(await rows('uow_tag')).to.have.length(0);
  });

  it('keeps the statement when the middleware does not ask for a transaction', async () => {
    asksForTransaction = false;
    failAfter = true;

    await expect(UowTag.insert({ Name: 'red' })).to.be.rejectedWith('after hook failed');

    expect(await rows('uow_tag')).to.have.length(1);
  });

  it('wraps a delete the same way', async () => {
    await UowTag.insert({ Name: 'red' });
    failAfter = true;

    await expect(UowTag.destroy(1)).to.be.rejectedWith('after hook failed');

    expect(await rows('uow_tag')).to.have.length(1);
  });

  it('leaves both writes to a caller transaction', async () => {
    await expect(
      UowTag.transaction(async () => {
        await UowTag.insert({ Name: 'red' });
        throw new Error('caller failed');
      }),
    ).to.be.rejectedWith('caller failed');

    expect(await rows('uow_tag')).to.have.length(0);
    expect(await rows('uow_client')).to.have.length(0);
  });
});
