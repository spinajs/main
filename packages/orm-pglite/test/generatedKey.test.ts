import 'mocha';
import { expect } from 'chai';
import { FrameworkConfiguration } from '@spinajs/configuration';
import '@spinajs/log';
// Relation and SingleRelation are value imports: the decorator metadata of a relation property names its class.
import { BelongsTo, Connection, ConstraintViolation, HasMany, Int64, Model, ModelBase, Orm, Primary, QueryContext, Relation, SingleRelation, Uuid, UuidConverter } from '@spinajs/orm';
import { createTestApp, type TestApp } from '@spinajs/testing';

import { PgliteOrmDriver } from '../src/index.js';

const CONNECTION = 'pglite-generated-key';

class PgliteGeneratedKeyConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.set('logger', { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] });
    this.set('db', { StrictTableCheck: false, Connections: [{ Driver: 'orm-driver-pglite', Name: CONNECTION }] });
  }
}

@Connection(CONNECTION)
@Model('pgl_gen_tag')
class PglGenTag extends ModelBase {
  @Primary()
  @Uuid()
  public Id: string;

  public Name: string;

  @HasMany('PglGenNote', { foreignKey: 'tag_id', primaryKey: 'Id' })
  public Notes: Relation<PglGenNote, PglGenTag>;
}

@Connection(CONNECTION)
@Model('pgl_gen_note')
class PglGenNote extends ModelBase {
  @Primary()
  public Id: number;

  public Text: string;

  @Uuid()
  public tag_id: string;

  @BelongsTo(PglGenTag, 'tag_id', 'Id')
  public Tag: SingleRelation<PglGenTag>;
}

@Connection(CONNECTION)
@Model('pgl_client_uuid_item')
class PglClientUuidItem extends ModelBase {
  @Primary({ generated: 'uuid' })
  @Uuid()
  public Id: string;

  public Name: string;
}

@Connection(CONNECTION)
@Model('pgl_serial_item')
class PglSerialItem extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection(CONNECTION)
@Model('pgl_bigserial_item')
class PglBigSerialItem extends ModelBase {
  @Primary()
  @Int64()
  public Id: string;

  public Name: string;
}

@Connection(CONNECTION)
@Model('pgl_no_default_item')
class PglNoDefaultItem extends ModelBase {
  @Primary()
  @Uuid()
  public Id: string;

  public Name: string;
}

describe('a primary key the database generates on PGlite', function () {
  this.timeout(60000);

  let app: TestApp | undefined;
  let driver: PgliteOrmDriver;

  const bytesOf = (key: string) => new UuidConverter().toDB(key)!;

  async function rows<T>(table: string): Promise<T[]> {
    return (await driver.executeOnDb(`SELECT * FROM ${table} ORDER BY 1`, [], QueryContext.Select)) as T[];
  }

  async function tagRows(): Promise<Array<{ Id: Uint8Array; Name: string }>> {
    return rows<{ Id: Uint8Array; Name: string }>('pgl_gen_tag');
  }

  before(async () => {
    app = await createTestApp({ configuration: PgliteGeneratedKeyConfiguration, register: (c) => c.register(PgliteOrmDriver).as('orm-driver-pglite') });
    const orm = await app.resolve(Orm);
    driver = orm.Connections.get(CONNECTION) as PgliteOrmDriver;
    await driver.executeOnDb('CREATE TABLE pgl_gen_tag ("Id" bytea PRIMARY KEY DEFAULT uuid_send(gen_random_uuid()), "Name" text)', [], QueryContext.Schema);
    await driver.executeOnDb('CREATE TABLE pgl_gen_note ("Id" serial PRIMARY KEY, "Text" text, "tag_id" bytea)', [], QueryContext.Schema);
    await driver.executeOnDb('CREATE TABLE pgl_client_uuid_item ("Id" bytea PRIMARY KEY, "Name" text)', [], QueryContext.Schema);
    await driver.executeOnDb('CREATE TABLE pgl_serial_item ("Id" serial PRIMARY KEY, "Name" text)', [], QueryContext.Schema);
    await driver.executeOnDb('CREATE TABLE pgl_bigserial_item ("Id" bigserial PRIMARY KEY, "Name" text)', [], QueryContext.Schema);
    await driver.executeOnDb('CREATE TABLE pgl_no_default_item ("Id" bytea PRIMARY KEY, "Name" text)', [], QueryContext.Schema);
    await orm.reloadTableInfo();
  });

  beforeEach(async () => {
    await driver.executeOnDb('TRUNCATE pgl_gen_tag, pgl_gen_note, pgl_client_uuid_item, pgl_serial_item, pgl_bigserial_item RESTART IDENTITY', [], QueryContext.Schema);
  });

  after(async () => {
    await app?.dispose();
  });

  describe('@Uuid() key without a value', () => {
    it('insert() leaves the key to the column default and the model reads its row back by the key it holds', async () => {
      const tag = new PglGenTag({ Name: 'urgent' });
      expect(tag.Id, 'no key before the insert: the table info replaces the column entry @Uuid() marked, so the constructor does not fill it').to.be.undefined;

      await tag.insert();

      const [row] = await tagRows();
      expect(row.Name).to.eq('urgent');
      expect(row.Id.byteLength).to.eq(16);
      expect(tag.Id, 'the key the model holds').to.exist;
      expect((await PglGenTag.where({ Id: tag.Id }).first())?.Name, 'read by the key the model holds').to.eq('urgent');
    });

    it('the static insert of an instance leaves the key to the column default', async () => {
      const tag = new PglGenTag({ Name: 'static' });

      await PglGenTag.insert(tag);

      const [row] = await tagRows();
      expect(row.Name).to.eq('static');
      expect(row.Id.byteLength).to.eq(16);
      expect(tag.Id, 'the key the model holds').to.exist;
      expect((await PglGenTag.where({ Id: tag.Id }).first())?.Name, 'read by the key the model holds').to.eq('static');
    });

    it('save() of a parent with a new child writes the generated key of the parent to the child', async () => {
      const tag = new PglGenTag({ Name: 'parent' });
      tag.Notes.push(new PglGenNote({ Text: 'note' }));

      await tag.save();

      const [tagRow] = await tagRows();
      const [noteRow] = await rows<{ tag_id: Uint8Array }>('pgl_gen_note');
      expect(tagRow.Id.byteLength).to.eq(16);
      expect(Buffer.from(noteRow.tag_id).equals(Buffer.from(tagRow.Id)), 'the child holds the key bytes of its parent').to.be.true;
      expect(tag.Id, 'the key the model holds').to.exist;
      expect((await PglGenTag.where({ Id: tag.Id }).first())?.Name, 'read by the key the model holds').to.eq('parent');
      expect((await PglGenNote.where({ tag_id: tag.Id })).map((n) => n.Text), 'children found through the key of the parent').to.deep.eq(['note']);
    });

    for (const empty of [null, '']) {
      it(`a key holding ${JSON.stringify(empty)} is left to the column default too`, async () => {
        const tag = new PglGenTag({ Name: 'empty' });
        (tag as unknown as { Id: unknown }).Id = empty;

        await tag.insert();

        const [row] = await tagRows();
        expect(row.Id.byteLength).to.eq(16);
        expect((await PglGenTag.where({ Id: tag.Id }).first())?.Name, 'read by the key the model holds').to.eq('empty');
      });
    }
  });

  describe('an auto key without a value on a column without a default', () => {
    async function failureOfInsert(): Promise<unknown> {
      return new PglNoDefaultItem({ Name: 'no default' }).insert().then(
        () => undefined,
        (err: unknown) => err,
      );
    }

    it('fails in the database with a not_null ConstraintViolation', async () => {
      const err = await failureOfInsert();

      expect(err).to.be.instanceOf(ConstraintViolation);
      expect((err as ConstraintViolation).kind).to.eq('not_null');
    });

    it('aborts the transaction of the caller', async () => {
      let next = '';
      const outcome = await driver
        .transaction(async () => {
          await failureOfInsert();
          next = await PglSerialItem.all().then(
            () => 'the next statement ran',
            (err: Error) => err.message,
          );
        })
        .then(
          () => 'committed',
          (err: Error) => err.message,
        );

      expect(next).to.match(/current transaction is aborted/);
      expect(outcome).to.match(/aborted by an earlier failed statement/);
    });
  });

  describe('a key with a value is written as before', () => {
    it('a key the caller supplies on the same model is the key of the row', async () => {
      const id = '0db8f7f5-56cd-4801-ac23-ad6d78bfec3f';
      await new PglGenTag({ Id: id, Name: 'supplied' }).insert();

      const [row] = await tagRows();
      expect(Buffer.from(row.Id).equals(bytesOf(id))).to.be.true;
    });

    it('a client-generated uuid key is the key of the row', async () => {
      const item = new PglClientUuidItem({ Name: 'client' });

      await item.insert();

      const [row] = await rows<{ Id: Uint8Array }>('pgl_client_uuid_item');
      expect(Buffer.from(row.Id).equals(bytesOf(item.Id))).to.be.true;
    });

    it('an auto-increment integer key is assigned by the database and read back', async () => {
      const item = new PglSerialItem({ Name: 'serial' });

      await item.insert();

      expect(item.Id).to.eq(1);
      expect((await rows<{ Id: number }>('pgl_serial_item')).map((r) => r.Id)).to.deep.eq([1]);
    });

    it('an @Int64() auto-increment key is assigned by the database and read back', async () => {
      const item = new PglBigSerialItem({ Name: 'bigserial' });

      await item.insert();

      expect(String(item.Id)).to.eq('1');
      expect((await PglBigSerialItem.where({ Id: item.Id }).first())?.Name).to.eq('bigserial');
    });
  });
});
