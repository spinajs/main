import { Configuration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';
import { HasManyToManyRelationMiddleware, Orm, SelectQueryBuilder } from '@spinajs/orm';
import type { IBuilderMiddleware, ICompilerOutput } from '@spinajs/orm';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db, migrations } from './common.js';
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
});
