import { DI } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import sinon from 'sinon';
import { Configuration, InvalidConfiguration } from '@spinajs/configuration';
import { FrameworkLogger } from '@spinajs/log';
import { WriteCaptureRequired, WriteObserver } from '@spinajs/orm';
import type { CaptureInterest, CapturedWrite, WriteStatement } from '@spinajs/orm';
import { SqliteOrmDriver } from '../src/index.js';
import { db } from './common.js';
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
  });

  it('does not see a builder without a model, like the rest of the capture', async () => {
    await requireTables(['uow_tag']);

    await db().Connections.get('sqlite')!.insert().into('uow_tag').values({ Name: 'raw' });

    expect(await names('uow_tag')).to.deep.eq(['raw']);
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

    it('still refuses a statement the observer leaves alone', async () => {
      await requireTables(['uow_tag']);
      await UowTag.insert({ Name: 'red' });
      observed.updates = false;

      await expect(UowTag.update({ Name: 'green' }).where('Id', 1)).to.be.rejectedWith(WriteCaptureRequired, refusal('update'));

      expect(await names('uow_tag')).to.deep.eq(['red']);
    });
  });
});
