import { Configuration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';
import { extractModelDescriptor, HasManyToManyRelationMiddleware, Orm, SelectQueryBuilder } from '@spinajs/orm';
import type { IBuilderMiddleware, ICompilerOutput, IWhereBuilder } from '@spinajs/orm';
import { Lazy } from '@spinajs/util';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db, migrations } from './common.js';
import { Location } from './models/Location.js';
import { LocationNetwork } from './models/LocationNetwork.js';
import { Offer } from './models/Offer.js';
import { OfferLocation } from './models/OfferLocation.js';
import './migrations/TestMigration_2022_02_08_01_13_00.js';

function offerWithNetworks() {
  return Offer.where({ Id: 1 }).populate('Localisations', function () {
    this.populate('Network');
  });
}

function sql(query: { toDB(): ICompilerOutput | ICompilerOutput[] }): string | null {
  const out = query.toDB();
  return (Array.isArray(out) ? out[0] : out).expression;
}

function junctionQuery(query: object): SelectQueryBuilder {
  (query as { toDB(): unknown }).toDB();
  const middlewares = (query as { _middlewares: IBuilderMiddleware[] })._middlewares;
  const found = middlewares.find((m) => m instanceof HasManyToManyRelationMiddleware);
  if (!found) {
    throw new Error('the populate registered no HasManyToManyRelationMiddleware');
  }
  return (found as unknown as { _relationQuery: SelectQueryBuilder })._relationQuery;
}

function locationsWithNetworks() {
  return OfferLocation.select().populate('Location', function () {
    this.populate('Network');
  });
}

function networksOf(rows: OfferLocation[]): string[] {
  return rows.map((r) => `${r.Location.Value!.Name}/${r.Location.Value!.Network.Value!.Name}`);
}

function networkNames(offers: Offer[]): string[] {
  return offers.flatMap((o) => [...o.Localisations].map((l) => l.Network.Value!.Name)).sort();
}

describe('clone() of a populated query', function () {
  this.timeout(10000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }
    await DI.resolve(Orm);
    await (await migrations()).up();
    await db().reloadTableInfo();
  });

  afterEach(() => DI.clearCache());

  it('returns the rows of the original for a many-to-many with a nested belongsTo', async () => {
    const query = offerWithNetworks();
    const original = await query;
    const cloned = await query.clone();

    expect(cloned.map((o) => o.Id)).to.deep.equal(original.map((o) => o.Id));
    expect(networkNames(cloned)).to.deep.equal(networkNames(original));
    expect(networkNames(cloned)).to.deep.equal(['Network 1', 'Network 1']);
  });

  it('a clone of the junction query joins the nested belongsTo from the target alias', async () => {
    const junction = junctionQuery(offerWithNetworks());
    const copy = junction.clone();

    expect(sql(copy)).to.contain('ON `$Localisations$`.`Network_id` = ');
    expect(sql(copy)).to.eq(sql(junction));

    const cloned = await copy.asRaw<Record<string, unknown>[]>();
    expect(cloned).to.deep.equal(await junction.asRaw<Record<string, unknown>[]>());
    expect(cloned.map((r) => r['$Localisations$.$Network$.Name'])).to.deep.equal(['Network 1', 'Network 1']);
  });

  it('loads fresh related rows when the source query was executed', async () => {
    const query = offerWithNetworks();
    expect(networkNames(await query)).to.deep.equal(['Network 1', 'Network 1']);

    await db().Connections.get('sqlite')!.update().in('location_network').update({ Name: 'Renamed' }).where({ Id: 1 });

    expect(networkNames(await query.clone())).to.deep.equal(['Renamed', 'Renamed']);
  });

  it('keeps the source alias of a belongsTo nested in a belongsTo of an executed query', async () => {
    const query = OfferLocation.select().populate('Location', function () {
      this.populate('Network');
    });
    const original = await query;
    const copy = query.clone();

    expect(sql(copy)).to.eq(sql(query));
    const cloned = await copy;
    expect(cloned.map((r) => r.Location.Value.Network.Value!.Name)).to.deep.equal(original.map((r) => r.Location.Value.Network.Value!.Name));
  });

  it('keeps the original and the clone apart when either is narrowed', async () => {
    const query = OfferLocation.select().populate('Location', function () {
      this.populate('Network');
    });
    await query;
    const before = sql(query);

    const copy = query.clone().where('Offer_id', 1).take(1).order('Id');
    const copied = sql(copy);
    expect(sql(query)).to.eq(before);

    query.where('Offer_id', 2).skip(1);
    expect(sql(copy)).to.eq(copied);
    expect(copied).to.not.eq(sql(query));
  });

  describe('taken before the original compiles', () => {
    it('loads a belongsTo nested in a belongsTo with the rows of the original', async () => {
      const query = locationsWithNetworks();
      const copy = query.clone();

      expect(sql(copy)).to.eq(sql(query));
      const cloned = await copy;
      expect(networksOf(cloned)).to.deep.equal(networksOf(await query));
      expect(networksOf(cloned)).to.deep.equal(['Loc 1/Network 1', 'Loc 2/Network 1']);
    });

    it('loads a hasMany with the rows of the original', async () => {
      const query = Location.select().populate('Metadata');
      const copy = query.clone();

      const keys = (rows: Location[]) => rows.map((l) => [...l.Metadata].map((m) => m.Key).join());
      const original = await query;
      expect(keys(await copy)).to.deep.equal(keys(original));
      expect(keys(original)).to.deep.equal(['meta 1', 'meta 2']);
    });

    it('loads a many-to-many with a nested belongsTo with the rows of the original', async () => {
      const query = offerWithNetworks();
      const copy = query.clone();

      const cloned = await copy;
      expect(networkNames(cloned)).to.deep.equal(networkNames(await query));
      expect(networkNames(cloned)).to.deep.equal(['Network 1', 'Network 1']);
    });

    it('compiles the clone and the original independently, in either order', async () => {
      const first = locationsWithNetworks();
      const firstCopy = first.clone();
      const second = locationsWithNetworks();
      const secondCopy = second.clone();

      const compiled = [sql(firstCopy), sql(first), sql(second), sql(secondCopy)];
      expect(new Set(compiled).size).to.eq(1);
      expect(String(compiled[0])).to.contain('LEFT JOIN `location_network` as `$Location$.$Network$` ON `$Location$`.`Network_id` = ');
      expect(String(compiled[0]).match(/LEFT JOIN/g)).to.have.length(2);
    });

    it('narrowing a relation of the clone leaves the original alone', async () => {
      const query = locationsWithNetworks();
      const before = sql(query.clone());
      const copy = query.clone().populate('Location', function () {
        this.where('Name', 'Loc 1');
      });

      const cloned = await copy;
      const original = await query;
      expect(sql(query)).to.eq(before);
      expect(networksOf(original)).to.deep.equal(['Loc 1/Network 1', 'Loc 2/Network 1']);
      expect(networksOf(cloned)).to.deep.equal(['Loc 1/Network 1']);
    });
  });

  it('a clone keeps a whereOnJoin() of a populate in the join, before and after the original compiles', async () => {
    const query = OfferLocation.select().populate('Location', function () {
      this.whereOnJoin(function () {
        this.where('Name', 'Loc 1');
      });
    });
    const early = query.clone();
    const original = await query;
    const late = query.clone();

    expect(original).to.have.length(2);
    expect((await early).map((r) => r.Id)).to.deep.equal(original.map((r) => r.Id));
    expect((await late).map((r) => r.Id)).to.deep.equal(original.map((r) => r.Id));
  });

  it('an OR in a belongs-to populate callback stays inside its own group', async () => {
    // offer_location 1 joins Loc 1, offer_location 2 joins Loc 2
    const query = () =>
      OfferLocation.where('Id', 1).populate('Location', function () {
        this.where('Name', 'Loc 1').orWhere('Name', 'Loc 2');
      });

    expect((await query()).map((r) => r.Id)).to.deep.equal([1]);
    expect((await query().clone()).map((r) => r.Id)).to.deep.equal([1]);

    const executed = query();
    await executed;
    expect((await executed.clone()).map((r) => r.Id)).to.deep.equal([1]);
  });

  it('a clone of an executed query keeps a Lazy condition of the callback group on its relation query', async () => {
    const query = OfferLocation.where('Id', 1).populate('Location', function () {
      this.where('Name', 'zzz').orWhere(
        new Lazy(function (this: IWhereBuilder<unknown>) {
          this.where('Name', 'Loc 1');
        }),
      );
    });

    expect((await query).map((r) => r.Id)).to.deep.equal([1]);
    expect((await query.clone()).map((r) => r.Id)).to.deep.equal([1]);
  });

  it('a populate callback that starts with orWhere() is joined to the owner conditions with AND', async () => {
    const query = OfferLocation.where('Id', 1).populate('Location', function () {
      this.orWhere('Name', 'Loc 2');
    });

    expect(sql(query)).to.contain('WHERE `$OfferLocation$`.`Id` = ? AND ( `$Location$`.`Name` = ? )');
    expect(await query).to.deep.equal([]);
  });

  it('keeps a nested populate condition out of the group, on the query and on its clones', async () => {
    const query = (network: string) =>
      OfferLocation.select().populate('Location', function () {
        this.where('Name', 'Loc 1').orWhere('Name', 'Loc 2');
        this.populate('Network', function () {
          this.where('Name', network);
        });
      });
    const ids = async (rows: PromiseLike<Array<{ Id: number }>>) => (await rows).map((r) => r.Id).sort((a, b) => a - b);

    // ( Loc 1 OR Loc 2 ) AND network: under the OR, `Loc 1 OR Loc 2 AND network` would keep row 1 for any network
    expect(await ids(query('No such network'))).to.deep.equal([]);
    expect(await ids(query('No such network').clone())).to.deep.equal([]);
    expect(await ids(query('Network 1'))).to.deep.equal([1, 2]);
    expect(await ids(query('Network 1').clone())).to.deep.equal([1, 2]);

    // a clone of an executed query copies the group and the nested condition, each bound to its own relation query
    const executed = query('Network 1');
    await executed;
    expect(await ids(executed.clone())).to.deep.equal([1, 2]);
    const refused = query('No such network');
    await refused;
    expect(await ids(refused.clone())).to.deep.equal([]);
  });

  it('keeps an aggregate condition of a nested populate at the top level, where HAVING reads it', () => {
    const name = extractModelDescriptor(LocationNetwork)!.Columns.find((c) => c.Name === 'Name')!;
    name.Aggregate = true;
    try {
      const compiled = String(
        sql(
          OfferLocation.select().populate('Location', function () {
            this.where('Id', 1).orWhere('Id', 2);
            this.populate('Network', function () {
              this.where('Name', 'Network 1');
            });
          }),
        ),
      );

      expect(compiled).to.contain('WHERE ( `$Location$`.`Id` = ? OR `$Location$`.`Id` = ? )');
      expect(compiled).to.contain('HAVING `Name` = ?');
      expect(compiled).to.not.contain('`$Location$.$Network$`.`Name` = ?');
    } finally {
      name.Aggregate = false;
    }
  });

  it('keeps an aggregate condition of the callback at the top level, where HAVING reads it', () => {
    const name = extractModelDescriptor(Location)!.Columns.find((c) => c.Name === 'Name')!;
    name.Aggregate = true;
    try {
      const compiled = String(
        sql(
          OfferLocation.select().populate('Location', function () {
            this.where('Id', 1).orWhere('Id', 2).where('Name', 'Loc 1');
          }),
        ),
      );

      expect(compiled).to.contain('WHERE ( `$Location$`.`Id` = ? OR `$Location$`.`Id` = ? )');
      expect(compiled).to.contain('HAVING `Name` = ?');
    } finally {
      name.Aggregate = false;
    }
  });

  it('a clone keeps orWhere() as OR, in the query and in a populate callback', async () => {
    const query = OfferLocation.where('Id', 1).orWhere('Id', 2);
    const populated = OfferLocation.select().populate('Location', function () {
      this.where('Name', 'Loc 1').orWhere('Name', 'Loc 2');
    });

    expect(await query.clone().selectCount()).to.eq(2);
    expect(await query.clone()).to.have.length(2);
    const copy = populated.clone();
    expect(await populated).to.have.length(2);
    expect(await copy).to.have.length(2);
  });

  describe('count() of a populated query', () => {
    it('counts through the belongs-to joins of the populate, selecting no relation column', async () => {
      const query = locationsWithNetworks();
      const count = String(sql(query.clone().count()));

      expect(count.slice(0, count.indexOf(' FROM '))).to.eq('SELECT COUNT(*) as `count`');
      expect(count.match(/LEFT JOIN/g)).to.have.length(2);
      expect(await query.clone().selectCount()).to.eq(2);
      expect(await query).to.have.length(2);
    });

    it('a count of a populated query selects only the count', () => {
      const count = String(sql(locationsWithNetworks().count()));

      expect(count.slice(0, count.indexOf(' FROM '))).to.eq('SELECT COUNT(*) as `count`');
    });

    it('counts a named column through the joins without ambiguity', async () => {
      expect(await locationsWithNetworks().selectCount('Id')).to.eq(2);
    });

    it('a where inside a has-many populate does not narrow the count', async () => {
      await db().Connections.get('sqlite')!.insert().into('locationmeta').values({ location_id: 1, Key: 'meta 3' });
      const query = () =>
        Location.select().populate('Metadata', function () {
          this.where('Key', 'meta 1');
        });

      expect(sql(query().count())).to.not.contain('JOIN');
      expect(await query().selectCount()).to.eq(2);
      expect(await query()).to.have.length(2);
    });

    it('a many-to-many populate does not join into the count', async () => {
      expect(sql(offerWithNetworks().count())).to.not.contain('JOIN');
      expect(await offerWithNetworks().selectCount()).to.eq(1);
      expect(await offerWithNetworks()).to.have.length(1);
    });

    it('a where inside a belongsTo populate narrows the rows and the count alike', async () => {
      const narrowed = () =>
        OfferLocation.select().populate('Location', function () {
          this.where('Name', 'Loc 1');
        });
      const query = narrowed();

      expect(await query.clone().selectCount()).to.eq(1);
      expect(await narrowed().selectCount()).to.eq(1);
      expect(await query).to.have.length(1);
    });

    it('a where inside a belongsTo nested in a belongsTo narrows the rows and the count alike', async () => {
      const narrowed = () =>
        OfferLocation.select().populate('Location', function () {
          this.populate('Network', function () {
            this.where('Name', 'Network 2');
          });
        });

      expect(await narrowed().selectCount()).to.eq(0);
      expect(await narrowed()).to.have.length(0);
    });

    it('a where on a belongs-to relation column narrows the count, as an orm-http filter builds it', async () => {
      expect(await OfferLocation.where('Location.Name', '=', 'Loc 1').selectCount()).to.eq(1);
      expect(await OfferLocation.where('Location.Name', '=', 'Loc 1')).to.have.length(1);
    });

    it('a whereOnJoin() of a belongsTo populate narrows neither the rows nor the count', async () => {
      const query = () =>
        OfferLocation.select().populate('Location', function () {
          this.whereOnJoin(function () {
            this.where('Name', 'Loc 1');
          });
        });

      expect(await query().selectCount()).to.eq(2);
      expect(await query()).to.have.length(2);
    });

    it('counts a row whose belongs-to target is missing, as the rows keep it', async () => {
      await db().Connections.get('sqlite')!.insert().into('offer_location').values({ Localisation: 99, Offer_id: 1 });

      expect(await locationsWithNetworks().selectCount()).to.eq(3);
      expect(await locationsWithNetworks()).to.have.length(3);
    });
  });
});
