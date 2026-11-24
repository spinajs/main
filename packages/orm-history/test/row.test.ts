import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { DI } from '@spinajs/di';
import { ModelBase, Primary } from '@spinajs/orm';
import { History, HistoryConfigError, historyOf, registerHistory } from '../src/index.js';
import type { TrackedModel, TrackedRow } from '../src/index.js';
import { OrmModelHistorySource } from '../src/read.js';
import { ModelHistorySource } from '../src/types.js';
import { HistoryDb } from './support/db.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

class Loose extends ModelBase {}

// `new` on a class of `define` takes the construct signature of ModelBase, so the row's type lacks the member it has.
const tracked = (row: ModelBase): row is ModelBase & TrackedRow => typeof Reflect.get(row, 'history') === 'function';

function unsaved(model: new () => ModelBase): ModelBase & TrackedRow {
  const row = new model();
  if (!tracked(row)) throw new Error(`${model.name} rows have no history member`);
  return row;
}

describe('row.history()', function () {
  this.timeout(60000);
  let db: HistoryDb;
  let Invoice: Awaited<ReturnType<HistoryDb['define']>>;

  before(async () => {
    db = await HistoryDb.open();
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.migrateHistory('sqlite');
    Invoice = await db.define({ name: 'Invoice', table: 'invoice', columns: { status: 'TEXT' }, decorate: (c) => registerHistory(c) }, 'sqlite');
  });

  afterEach(async () => {
    await db.clear();
  });

  it('reads and forgets the history of a loaded row', async () => {
    await Invoice.insert({ id: 'i7', status: 'draft' });
    await Invoice.update({ status: 'paid' }).where('id', 'i7');
    await Invoice.insert({ id: 'i8', status: 'draft' });

    const row = await Invoice.get('i7');
    expect((await row.history().entries()).map((e) => [e.id, e.op])).to.deep.eq([['i7', 'insert'], ['i7', 'update']]);
    expect(await row.history().entries({ limit: 1 })).to.have.length(1);
    const now = await row.history().asOf(new Date(Date.now() + 1000));
    expect(now.state === 'present' && now.row.status).to.eq('paid');

    expect(await row.history().forget()).to.eq(2);
    expect((await Invoice.history().of('i7')).every((e) => e.redacted)).to.eq(true);
    expect((await Invoice.history().of('i8')).map((e) => e.redacted)).to.deep.eq([false]);
  });

  it('refuses an instance that was never saved and a model that is not tracked', () => {
    expect(() => unsaved(Invoice).history()).to.throw(HistoryConfigError, 'orm-history: this Invoice has no primary key value yet, so it has no history; save it first');
    expect(() => historyOf(Loose)).to.throw(HistoryConfigError, 'orm-history: Loose is not tracked (no @History and no audit.data.rules match)');
  });

  it('reads the history of a row of a concrete subclass of a marked abstract base that holds the key', async () => {
    @History()
    abstract class Shared<M> extends ModelBase<M> implements TrackedRow {
      declare static history: TrackedModel['history'];
      declare history: TrackedRow['history'];

      @Primary()
      public id: string;
    }
    const Note = await db.define({ name: 'Note', table: 'tenant_note', columns: { body: 'TEXT' }, abstractBase: Shared, decorate: () => undefined }, 'sqlite');
    await Note.insert({ id: 'n1', body: 'draft' });

    const row = await Note.get('n1');
    expect((await row.history().entries()).map((e) => [e.id, e.op])).to.deep.eq([['n1', 'insert']]);
    expect((await Note.history().of('n1')).map((e) => e.op)).to.deep.eq(['insert']);
  });

  it('gives the abstract base that holds the key a history that cannot be read', async () => {
    @History()
    abstract class Shared<M> extends ModelBase<M> implements TrackedRow {
      declare static history: TrackedModel['history'];
      declare history: TrackedRow['history'];

      @Primary()
      public id: string;
    }
    await db.define({ name: 'Note', table: 'tenant_note', columns: {}, abstractBase: Shared, decorate: () => undefined }, 'sqlite');

    const history = Shared.history();
    await expect(history.of('n1')).to.be.rejectedWith(HistoryConfigError, 'orm-history: Shared has no ORM connection yet (is the ORM booted?)');
  });

  it('refuses a subclass that opted out of its marked base, through the member it inherits', async () => {
    const Quiet = await db.define({ name: 'Quiet', table: 'invoice', columns: {}, base: Invoice, decorate: (c) => registerHistory(c, false) }, 'sqlite');
    expect([Object.hasOwn(Quiet, 'history'), 'history' in Quiet, 'history' in Quiet.prototype]).to.deep.eq([false, true, true]);
    const message = 'orm-history: Quiet is not tracked (no @History and no audit.data.rules match)';
    expect(() => Quiet.history()).to.throw(HistoryConfigError, message);
    const row = unsaved(Quiet);
    row.PrimaryKeyValue = 'q1';
    expect(() => row.history()).to.throw(HistoryConfigError, message);
  });

  it('refuses a row whose constructor is not a model class', () => {
    const plain = new Invoice();
    Object.defineProperty(plain, 'constructor', { value: Object });
    expect(() => historyOf(plain)).to.throw(HistoryConfigError, 'orm-history: Object is not tracked (no @History and no audit.data.rules match)');
    const bare = new Invoice();
    Object.defineProperty(bare, 'constructor', { value: undefined });
    expect(() => historyOf(bare)).to.throw(HistoryConfigError, 'orm-history: undefined is not tracked (no @History and no audit.data.rules match)');
  });

  it('answers through the source the package registers', () => {
    expect(DI.resolve(ModelHistorySource)).to.be.instanceOf(OrmModelHistorySource);
  });
});
