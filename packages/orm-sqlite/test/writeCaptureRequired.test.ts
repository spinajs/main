import { DI } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import sinon from 'sinon';
import { Configuration, InvalidConfiguration } from '@spinajs/configuration';
import { FrameworkLogger } from '@spinajs/log';
import { InsertQueryBuilder, WriteCaptureRequired, WriteObserver, createQuery, deleteChunked, insertChunked, purgeBatch } from '@spinajs/orm';
import type { CaptureInterest, CapturedWrite, WriteStatement } from '@spinajs/orm';
import { SqliteOrmDriver } from '../src/index.js';
import { TEST_MIGRATION_TABLE_NAME, db } from './common.js';
import { bootUow, captureStatements, registerUowConnection, rows, UowClient, UowTag } from './uowFixture.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

// Module state, not instance state: DI makes a new observer after every DI.clearCache().
const observed = { writes: [] as CapturedWrite[], updates: true };

class TagObserver extends WriteObserver {
  interest({ model, kind }: WriteStatement): CaptureInterest | undefined {
    if (model !== UowTag) return undefined;
    return kind === 'update' && !observed.updates ? undefined : { columns: '*', transactional: true };
  }

  async observe(write: CapturedWrite): Promise<void> {
    observed.writes.push(write);
  }
}

const refusal = (kind: 'insert' | 'update' | 'delete'): string => `write capture: UowTag writes uow_tag, a table db.WriteCapture.Required lists, and no WriteObserver takes this ${kind}; load the package that observes uow_tag in this process or take the table off the list`;

type PastModel = 'an insert' | 'an update' | 'a delete' | 'a truncate';

const unseen = (phrase: PastModel, table = 'uow_tag'): string => `write capture: ${phrase} of ${table}, a table db.WriteCapture.Required lists, does not go through the table's model, so no WriteObserver can take it; write it through its model, or with raw SQL where it must not be recorded`;

const sqlite = (): SqliteOrmDriver => {
  const driver = db().Connections.get('sqlite');
  if (!(driver instanceof SqliteOrmDriver)) throw new Error('the sqlite connection is not a SqliteOrmDriver');
  return driver;
};

async function requireTables(tables: string[]): Promise<void> {
  (await DI.resolve(Configuration)).set('db.WriteCapture.Required', tables);
}

const names = async (table: string): Promise<string[]> => (await rows<{ Name: string }>(table)).map((r) => r.Name);

const onTags = (statements: { expression: string }[]): string[] => statements.map((s) => s.expression).filter((e) => e.includes('uow_tag'));

describe('db.WriteCapture.Required on sqlite', function () {
  // Each test boots the ORM again, which takes several seconds on a loaded machine.
  this.timeout(60000);

  before(() => registerUowConnection());

  beforeEach(async () => {
    await bootUow();
    observed.writes = [];
    observed.updates = true;
  });

  // A list left behind would refuse the unobserved writes of whatever runs next in this process.
  afterEach(async () => {
    await requireTables([]);
    DI.clearCache();
  });

  it('refuses nothing and adds nothing while no table is listed', async () => {
    const { statements, restore } = captureStatements();
    try {
      await UowTag.insert({ Name: 'red' });
      await requireTables([]);
      await UowTag.update({ Name: 'green' }).where('Id', 1);
    } finally {
      restore();
    }

    expect(onTags(statements)).to.have.length(2);
    expect(await names('uow_tag')).to.deep.eq(['green']);
  });

  it('refuses an insert, an update and a delete of a listed table that no observer takes, before any statement runs', async () => {
    await UowTag.insert({ Name: 'red' });
    await requireTables(['uow_tag']);
    const { statements, restore } = captureStatements();
    try {
      await expect(UowTag.insert({ Name: 'blue' })).to.be.rejectedWith(WriteCaptureRequired, refusal('insert'));
      await expect(UowTag.update({ Name: 'green' }).where('Id', 1)).to.be.rejectedWith(WriteCaptureRequired, refusal('update'));
      await expect(UowTag.destroy(1)).to.be.rejectedWith(WriteCaptureRequired, refusal('delete'));
    } finally {
      restore();
    }

    expect(statements).to.deep.eq([]);
    expect(await names('uow_tag')).to.deep.eq(['red']);
  });

  it("refuses inside a caller's transaction too, and nothing is written", async () => {
    await requireTables(['uow_tag']);
    const driver = db().Connections.get('sqlite');
    if (!(driver instanceof SqliteOrmDriver)) throw new Error('the sqlite connection is not a SqliteOrmDriver');
    const sent = sinon.spy(driver, 'executeOnDb');

    try {
      await expect(
        driver.transaction(async () => {
          await UowTag.insert({ Name: 'red' });
        }),
      ).to.be.rejectedWith(WriteCaptureRequired, refusal('insert'));
    } finally {
      sent.restore();
    }

    // BEGIN and ROLLBACK bypass executeOnDb; the insert, a savepoint or a capture read would not.
    expect(sent.getCalls().map((c) => c.args[0])).to.deep.eq([]);
    expect(await names('uow_tag')).to.deep.eq([]);
  });

  it('leaves a table that is not listed alone', async () => {
    await requireTables(['uow_tag']);
    const { statements, restore } = captureStatements();
    try {
      await UowClient.insert({ Name: 'x' });
    } finally {
      restore();
    }

    expect(statements).to.have.length(1);
    expect(await names('uow_client')).to.deep.eq(['x']);
  });

  it('compares table names without case, and never with the model class name', async () => {
    await requireTables(['UowTag']);
    await UowTag.insert({ Name: 'red' });

    await requireTables(['UOW_TAG']);
    await expect(UowTag.insert({ Name: 'blue' })).to.be.rejectedWith(WriteCaptureRequired, refusal('insert'));

    expect(await names('uow_tag')).to.deep.eq(['red']);
  });

  it('warns at boot about a listed name that no model of the process has, comparing without case', async () => {
    DI.clearCache();
    await requireTables(['UOW_TAG', 'uow_tags']);
    const warn = sinon.spy(FrameworkLogger.prototype, 'warn');
    try {
      await bootUow();
    } finally {
      warn.restore();
    }

    const unmatched = warn.getCalls().filter((c) => typeof c.args[1] === 'string' && c.args[1].startsWith('db.WriteCapture.Required lists'));
    expect(unmatched.map((c) => c.args[0])).to.deep.eq([{ table: 'uow_tags' }]);
    expect(unmatched.map((c) => c.args[1])).to.deep.eq(['db.WriteCapture.Required lists ${table}, and no model of this process has that table: here only its writes that go past a model are refused']);
  });

  it('refuses a write of a listed table that goes past its model, before any statement runs', async () => {
    await UowTag.insert({ Name: 'red' });
    await requireTables(['uow_tag']);
    const driver = sqlite();
    const { statements, restore } = captureStatements();
    try {
      await expect(driver.insert().into('uow_tag').values({ Name: 'bare' })).to.be.rejectedWith(WriteCaptureRequired, unseen('an insert'));
      await expect(driver.insert().into('uow_tag').values({ Id: 1, Name: 'bare' }).onDuplicate('Id').update(['Name'])).to.be.rejectedWith(WriteCaptureRequired, unseen('an insert'));
      await expect(driver.update().in('uow_tag').update({ Name: 'bare' }).where('Id', 1)).to.be.rejectedWith(WriteCaptureRequired, unseen('an update'));
      await expect(driver.del().from('uow_tag').where('Id', 1)).to.be.rejectedWith(WriteCaptureRequired, unseen('a delete'));
      await expect(insertChunked(driver, 'uow_tag', [{ Name: 'a' }, { Name: 'b' }])).to.be.rejectedWith(WriteCaptureRequired, unseen('an insert'));
      await expect(deleteChunked(driver, 'uow_tag', 'Id', [1])).to.be.rejectedWith(WriteCaptureRequired, unseen('a delete'));
      await expect(UowTag.truncate()).to.be.rejectedWith(WriteCaptureRequired, unseen('a truncate'));
      await expect(driver.truncate('uow_tag')).to.be.rejectedWith(WriteCaptureRequired, unseen('a truncate'));
      // The observers were asked about UowClient, not about the table this builder writes.
      await expect(createQuery(UowClient, InsertQueryBuilder).query.into('uow_tag').values({ Name: 'bare' })).to.be.rejectedWith(WriteCaptureRequired, unseen('an insert'));
      await expect(
        purgeBatch(driver, {
          table: 'uow_tag',
          key: 'Id',
          where: function () {
            this.where('Name', 'red');
          },
        }),
      ).to.be.rejectedWith(WriteCaptureRequired, unseen('a delete'));
    } finally {
      restore();
    }

    // Only the select of purgeBatch reached the driver.
    expect(statements.map((s) => s.expression.split(' ')[0])).to.deep.eq(['SELECT']);
    expect(await names('uow_tag')).to.deep.eq(['red']);
  });

  it('matches a qualified, quoted or aliased name of a write past the model by its table part, without case', async () => {
    await requireTables(['UOW_TAG']);
    const driver = sqlite();
    const { statements, restore } = captureStatements();
    try {
      await expect(driver.insert().into('uow_tag').values({ Name: 'a' })).to.be.rejectedWith(WriteCaptureRequired, unseen('an insert'));
      await expect(driver.insert().into('main.uow_tag').values({ Name: 'a' })).to.be.rejectedWith(WriteCaptureRequired, unseen('an insert', 'main.uow_tag'));
      await expect(driver.insert().into('"main"."Uow_Tag"').values({ Name: 'a' })).to.be.rejectedWith(WriteCaptureRequired, unseen('an insert', '"main"."Uow_Tag"'));
      await expect(driver.del().from('[uow_tag]').where('Id', 1)).to.be.rejectedWith(WriteCaptureRequired, unseen('a delete', '[uow_tag]'));
      await expect(driver.del().from('uow_tag', 't').where('Id', 1)).to.be.rejectedWith(WriteCaptureRequired, unseen('a delete'));
      await expect(driver.update().in('uow_tag').database('main').update({ Name: 'b' }).where('Id', 1)).to.be.rejectedWith(WriteCaptureRequired, unseen('an update'));
    } finally {
      restore();
    }

    expect(statements).to.deep.eq([]);
  });

  it('refuses a write past the model whose table name it cannot read while any table is listed', async () => {
    await requireTables(['uow_client']);
    const { statements, restore } = captureStatements();
    try {
      await expect(sqlite().insert().into('"uow_tag').values({ Name: 'a' })).to.be.rejectedWith(
        WriteCaptureRequired,
        `write capture: an insert of "uow_tag is refused: db.WriteCapture.Required lists tables, and the table of this name cannot be read; name it as table, schema.table or with quoted parts, or write it with raw SQL where it must not be recorded`,
      );
    } finally {
      restore();
    }

    expect(statements).to.deep.eq([]);
  });

  it("refuses a write past the model inside a caller's transaction, and sends nothing", async () => {
    await requireTables(['uow_tag']);
    const driver = sqlite();
    const sent = sinon.spy(driver, 'executeOnDb');

    try {
      await expect(
        driver.transaction(async () => {
          await driver.insert().into('uow_tag').values({ Name: 'bare' });
        }),
      ).to.be.rejectedWith(WriteCaptureRequired, unseen('an insert'));
    } finally {
      sent.restore();
    }

    // BEGIN and ROLLBACK bypass executeOnDb; the insert or a savepoint would not.
    expect(sent.getCalls().map((c) => c.args[0])).to.deep.eq([]);
    expect(await names('uow_tag')).to.deep.eq([]);
  });

  it('leaves raw SQL, an unlisted table and a write past the model under an empty list alone', async () => {
    const driver = sqlite();
    await driver.insert().into('uow_tag').values({ Name: 'bare' });
    await requireTables(['uow_tag']);
    await driver.insert().into('uow_client').values({ Name: 'x' });
    await driver.schema().raw('DELETE FROM uow_tag', []);

    expect(await names('uow_tag')).to.deep.eq([]);
    expect(await names('uow_client')).to.deep.eq(['x']);
  });

  it('reads the list at most once per statement, and not for a select', async () => {
    const config = await DI.resolve(Configuration);
    const driver = sqlite();
    const reads = async (statement: () => Promise<unknown>): Promise<number> => {
      const get = sinon.spy(config, 'get');
      try {
        await statement();
      } finally {
        get.restore();
      }
      return get.getCalls().filter((c) => c.args[0] === 'db.WriteCapture.Required').length;
    };

    expect([
      await reads(async () => driver.select().from('uow_tag')),
      await reads(async () => UowTag.where('Id', 1)),
      await reads(async () => driver.insert().into('uow_client').values({ Name: 'x' })),
      await reads(async () => UowTag.insert({ Name: 'red' })),
    ]).to.deep.eq([0, 0, 1, 1]);
  });

  it('runs the migrations with a table listed: the ORM bookkeeping tables are not on the list', async () => {
    DI.clearCache();
    await requireTables(['uow_tag']);
    await bootUow();

    expect(await rows(TEST_MIGRATION_TABLE_NAME)).to.not.be.empty;
  });

  it('takes only a list of table names: the configuration refuses anything else and keeps what it had', async () => {
    const config = await DI.resolve(Configuration);

    expect(() => config.set('db.WriteCapture.Required', 'uow_tag')).to.throw(InvalidConfiguration, 'db.WriteCapture.Required');
    expect(() => config.set('db.WriteCapture.Required', [''])).to.throw(InvalidConfiguration, 'db.WriteCapture.Required');
    // A misspelt key must not read as "no list".
    expect(() => config.set('db.WriteCapture.Requird', ['uow_tag'])).to.throw(InvalidConfiguration, 'db.WriteCapture.Requird');

    await UowTag.insert({ Name: 'red' });
    expect(await names('uow_tag')).to.deep.eq(['red']);
  });

  describe('with an observer of the table', () => {
    before(() => DI.register(TagObserver).as(WriteObserver));

    after(() => DI.unregister(TagObserver));

    it('lets the writes through that the observer takes', async () => {
      await requireTables(['uow_tag']);

      await UowTag.insert({ Name: 'red' });
      await UowTag.update({ Name: 'green' }).where('Id', 1);

      expect(observed.writes.map((w) => w.kind)).to.deep.eq(['insert', 'update']);
      expect(await names('uow_tag')).to.deep.eq(['green']);
    });

    it('still refuses a write past the model, which no observer is ever handed', async () => {
      await requireTables(['uow_tag']);

      await expect(sqlite().insert().into('uow_tag').values({ Name: 'bare' })).to.be.rejectedWith(WriteCaptureRequired, unseen('an insert'));
      await UowTag.insert({ Name: 'red' });

      expect(observed.writes.map((w) => w.kind)).to.deep.eq(['insert']);
      expect(await names('uow_tag')).to.deep.eq(['red']);
    });

    it('still refuses a statement the observer leaves alone', async () => {
      await requireTables(['uow_tag']);
      await UowTag.insert({ Name: 'red' });
      observed.updates = false;

      await expect(UowTag.update({ Name: 'green' }).where('Id', 1)).to.be.rejectedWith(WriteCaptureRequired, refusal('update'));

      expect(await names('uow_tag')).to.deep.eq(['red']);
    });
  });
});
