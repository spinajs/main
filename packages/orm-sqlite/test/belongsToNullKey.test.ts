import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { BelongsTo, Connection, InsertBehaviour, Model, ModelBase, Primary, QueryContext, Version } from '@spinajs/orm';
import type { SingleRelation } from '@spinajs/orm';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { SqliteOrmDriver } from '../src/index.js';
import { db } from './common.js';
import { bootUow, captureStatements, registerUowConnection, rows } from './uowFixture.js';
import type { ICapturedStatement } from './uowFixture.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

@Connection('sqlite')
@Model('bnk_owner')
class BnkOwner extends ModelBase<BnkOwner> {
  @Primary()
  public Id: number;
}

@Connection('sqlite')
@Model('bnk_owned')
class BnkOwned extends ModelBase<BnkOwned> {
  @Primary()
  public Id: number;

  public Name: string | null;

  public Note: string | null;

  public owner_id: number | null | undefined;

  @BelongsTo(BnkOwner, 'owner_id')
  public Owner: SingleRelation<BnkOwner>;
}

@Connection('sqlite')
@Model('bnk_versioned')
class BnkVersioned extends ModelBase<BnkVersioned> {
  @Primary()
  public Id: number;

  public owner_id: number | null;

  @Version()
  public Ver: number;

  @BelongsTo(BnkOwner, 'owner_id')
  public Owner: SingleRelation<BnkOwner>;
}

// owner_id INTEGER NULL DEFAULT 7
@Connection('sqlite')
@Model('bnk_def')
class BnkDefault extends ModelBase<BnkDefault> {
  @Primary()
  public Id: number;

  public Name: string;

  public owner_id: number | null;

  @BelongsTo(BnkOwner, 'owner_id')
  public Owner: SingleRelation<BnkOwner>;
}

// owner_id INTEGER NOT NULL DEFAULT 7
@Connection('sqlite')
@Model('bnk_nn')
class BnkNotNull extends ModelBase<BnkNotNull> {
  @Primary()
  public Id: number;

  public Name: string;

  public owner_id: number | null;

  @BelongsTo(BnkOwner, 'owner_id')
  public Owner: SingleRelation<BnkOwner>;
}

async function run(sql: string): Promise<void> {
  const connection = db().Connections.get('sqlite');
  if (!(connection instanceof SqliteOrmDriver)) {
    throw new Error('the sqlite connection is not booted');
  }
  await connection.executeOnDb(sql, [], QueryContext.Schema);
}

const writes = (statements: ICapturedStatement[]) => statements.filter((s) => s.context !== QueryContext.Select).map((s) => [s.expression, s.bindings]);

/** The statements other than SELECT that `fn` sends. */
async function writesOf(fn: () => PromiseLike<unknown>) {
  const capture = captureStatements();
  try {
    await fn();
    return writes(capture.statements);
  } finally {
    capture.restore();
  }
}

// The relation is never populated unless a test says so: `where().first()` and `new` leave `Owner.Value` undefined.
describe('sqlite @BelongsTo key set to null while its relation holds nothing', function () {
  this.timeout(30000);

  before(async () => {
    registerUowConnection();
    await bootUow();
    await run('CREATE TABLE bnk_owner (Id INTEGER PRIMARY KEY)');
    await run('CREATE TABLE bnk_owned (Id INTEGER PRIMARY KEY, Name TEXT NULL, Note TEXT NULL, owner_id INTEGER NULL)');
    await run('CREATE TABLE bnk_versioned (Id INTEGER PRIMARY KEY, owner_id INTEGER NULL, Ver INTEGER NOT NULL DEFAULT 1)');
    await run('CREATE TABLE bnk_def (Id INTEGER PRIMARY KEY, Name TEXT NULL, owner_id INTEGER NULL DEFAULT 7)');
    await run('CREATE TABLE bnk_nn (Id INTEGER PRIMARY KEY, Name TEXT NULL, owner_id INTEGER NOT NULL DEFAULT 7)');
    await db().reloadTableInfo();
  });

  beforeEach(async () => {
    for (const table of ['bnk_owner', 'bnk_owned', 'bnk_versioned', 'bnk_def', 'bnk_nn']) {
      await run(`DELETE FROM ${table}`);
    }
    await run('INSERT INTO bnk_owner VALUES (1), (2), (3)');
    await run("INSERT INTO bnk_owned VALUES (1, 'a', NULL, 3)");
    await run('INSERT INTO bnk_versioned VALUES (1, 3, 1)');
  });

  after(() => {
    DI.clearCache();
  });

  describe('an UPDATE writes the NULL', () => {
    it('U1: update() writes the key alone and leaves the model clean', async () => {
      const owned = await BnkOwned.where('Id', 1).first();
      owned.owner_id = null;

      expect(await writesOf(() => owned.update())).to.deep.eq([['UPDATE `bnk_owned` SET `owner_id` = ? WHERE `Id` = ?', [null, 1]]]);
      expect(await rows('bnk_owned')).to.deep.eq([{ Id: 1, Name: 'a', Note: null, owner_id: null }]);
      expect(owned.IsDirty).to.eq(false);
    });

    it('U2: update() writes the key together with another changed column', async () => {
      const owned = await BnkOwned.where('Id', 1).first();
      owned.owner_id = null;
      owned.Name = 'y';

      expect(await writesOf(() => owned.update())).to.deep.eq([['UPDATE `bnk_owned` SET `Name` = ?,`owner_id` = ? WHERE `Id` = ?', ['y', null, 1]]]);
      expect(await rows('bnk_owned')).to.deep.eq([{ Id: 1, Name: 'y', Note: null, owner_id: null }]);
    });

    it('U3: save() writes the key and counts the update', async () => {
      const owned = await BnkOwned.where('Id', 1).first();
      owned.owner_id = null;

      let updated = -1;
      expect(
        await writesOf(async () => {
          updated = (await owned.save()).Updated;
        }),
      ).to.deep.eq([['UPDATE `bnk_owned` SET `owner_id` = ? WHERE `Id` = ?', [null, 1]]]);
      expect(updated).to.eq(1);
      expect(await rows('bnk_owned')).to.deep.eq([{ Id: 1, Name: 'a', Note: null, owner_id: null }]);
    });

    it('U4: update() of an @Version model writes the key and moves the version', async () => {
      const versioned = await BnkVersioned.where('Id', 1).first();
      versioned.owner_id = null;

      expect(await writesOf(() => versioned.update())).to.deep.eq([['UPDATE `bnk_versioned` SET `owner_id` = ?,`Ver` = ? WHERE `Id` = ? AND `Ver` = ?', [null, 2, 1, 1]]]);
      expect(await rows('bnk_versioned')).to.deep.eq([{ Id: 1, owner_id: null, Ver: 2 }]);
    });

    it('U5: update() of a model built with new over an existing row writes the key', async () => {
      const owned = new BnkOwned({ Id: 1, Name: 'y', owner_id: null });

      // without a snapshot every column counts as changed; Note holds its model default, null
      expect(await writesOf(() => owned.update())).to.deep.eq([['UPDATE `bnk_owned` SET `Name` = ?,`Note` = ?,`owner_id` = ? WHERE `Id` = ?', ['y', null, null, 1]]]);
      expect(await rows('bnk_owned')).to.deep.eq([{ Id: 1, Name: 'y', Note: null, owner_id: null }]);
    });

    it('U6: insertOrUpdate() of a model built with new over an existing row writes the key', async () => {
      const owned = new BnkOwned({ Id: 1, Name: 'y', owner_id: null });

      expect(await writesOf(() => owned.insertOrUpdate())).to.deep.eq([['UPDATE `bnk_owned` SET `Name` = ?,`Note` = ?,`owner_id` = ? WHERE `Id` = ?', ['y', null, null, 1]]]);
      expect(await rows('bnk_owned')).to.deep.eq([{ Id: 1, Name: 'y', Note: null, owner_id: null }]);
    });
  });

  describe('what stays as it is', () => {
    it('U7: a key set to undefined is not written', async () => {
      const owned = await BnkOwned.where('Id', 1).first();
      owned.owner_id = undefined;
      owned.Name = 'y';

      expect(await writesOf(() => owned.update())).to.deep.eq([['UPDATE `bnk_owned` SET `Name` = ? WHERE `Id` = ?', ['y', 1]]]);
      expect(await rows('bnk_owned')).to.deep.eq([{ Id: 1, Name: 'y', Note: null, owner_id: 3 }]);
    });

    it('U8: a populated relation decides the key, so setting the column to null writes nothing', async () => {
      const owned = await BnkOwned.where('Id', 1).populate('Owner').first();
      owned.owner_id = null;
      owned.Name = 'y';

      expect(await writesOf(() => owned.update())).to.deep.eq([['UPDATE `bnk_owned` SET `Name` = ? WHERE `Id` = ?', ['y', 1]]]);
      expect(await rows('bnk_owned')).to.deep.eq([{ Id: 1, Name: 'y', Note: null, owner_id: 3 }]);
    });

    it('a key re-pointed to another row is written', async () => {
      const owned = await BnkOwned.where('Id', 1).first();
      owned.owner_id = 2;

      expect(await writesOf(() => owned.update())).to.deep.eq([['UPDATE `bnk_owned` SET `owner_id` = ? WHERE `Id` = ?', [2, 1]]]);
    });

    // An INSERT leaves the null key out, so the column default applies; ox-47 may change that.
    for (const [label, M, table] of [
      ['owner_id NULL DEFAULT 7', BnkDefault, 'bnk_def'],
      ['owner_id NOT NULL DEFAULT 7', BnkNotNull, 'bnk_nn'],
    ] as const) {
      describe(`an INSERT leaves the key out (${label})`, () => {
        const plain = `INSERT INTO \`${table}\` (\`Id\`,\`Name\`) VALUES (?,?)  RETURNING \`Id\``;

        it('new M({ owner_id: null }).insert(), and the same after assigning null', async () => {
          expect(await writesOf(() => new M({ Id: 1, Name: 'a', owner_id: null }).insert())).to.deep.eq([[plain, [1, 'a']]]);
          const assigned = new M({ Id: 2, Name: 'b' });
          assigned.owner_id = null;
          expect(await writesOf(() => assigned.insert())).to.deep.eq([[plain, [2, 'b']]]);
          expect(await rows(table)).to.deep.eq([
            { Id: 1, Name: 'a', owner_id: 7 },
            { Id: 2, Name: 'b', owner_id: 7 },
          ]);
        });

        it('static insert(new M({ owner_id: null })) and save() of a new model', async () => {
          expect(await writesOf(() => M.insert(new M({ Id: 1, Name: 'a', owner_id: null })))).to.deep.eq([[plain, [1, 'a']]]);
          expect(await writesOf(() => new M({ Id: 2, Name: 'b', owner_id: null }).save())).to.deep.eq([[plain, [2, 'b']]]);
          expect((await rows<{ owner_id: number }>(table)).map((r) => r.owner_id)).to.deep.eq([7, 7]);
        });

        it('insert(InsertOrIgnore)', async () => {
          expect(await writesOf(() => new M({ Id: 1, Name: 'a', owner_id: null }).insert(InsertBehaviour.InsertOrIgnore))).to.deep.eq([[`INSERT OR IGNORE INTO \`${table}\` (\`Id\`,\`Name\`) VALUES (?,?)  RETURNING \`Id\``, [1, 'a']]]);
          expect((await rows<{ owner_id: number }>(table)).map((r) => r.owner_id)).to.deep.eq([7]);
        });

        // ox-46 limits the conflict update list to the columns the insert writes.
        it('insert(InsertOrUpdate)', async () => {
          expect(await writesOf(() => new M({ Id: 1, Name: 'a', owner_id: null }).insert(InsertBehaviour.InsertOrUpdate))).to.deep.eq([
            [`INSERT INTO \`${table}\` (\`Id\`,\`Name\`) VALUES (?,?) ON CONFLICT(\`Id\`) DO UPDATE SET \`Name\` = excluded.\`Name\`,\`owner_id\` = excluded.\`owner_id\` RETURNING *;`, [1, 'a']],
          ]);
          expect((await rows<{ owner_id: number }>(table)).map((r) => r.owner_id)).to.deep.eq([7]);
        });
      });
    }

    it('a bulk insert mixing a model with a null key and a row that sets it still throws', async () => {
      await expect(BnkDefault.insert([new BnkDefault({ Id: 1, Name: 'a', owner_id: null }), { Id: 2, Name: 'b', owner_id: null }])).to.be.rejectedWith(InvalidArgument, 'a row has no value for column owner_id that other rows set');
    });
  });
});
