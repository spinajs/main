/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Configuration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';
import { Offer } from './models/Offer.js';
import './migrations/TestMigration_2022_02_08_01_13_00.js';

describe('nested relations under a many-to-many', function () {
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
    await db().Migration.up();
    await db().reloadTableInfo();
  });

  afterEach(() => DI.clearCache());

  it('loads two nested belongsTo chains without duplicating relation data', async () => {
    const offer = await Offer.where({ Id: 1 })
      .populate('Localisations', function (this: any) {
        this.populate('Network');
        this.populate('Metadata');
      })
      .first();

    expect(offer.Localisations.length).to.equal(2);

    for (const location of [...offer.Localisations]) {
      expect((location as any).Network.Value, 'network not loaded').to.not.equal(undefined);
      // locationmeta seeds exactly one row per location.
      expect((location as any).Metadata.length, 'metadata duplicated').to.equal(1);
    }
  });

  it('issues each nested relation query once', async () => {
    const connection: any = db().Connections.get('sqlite')!;
    const original = connection.execute.bind(connection);
    const expressions: string[] = [];

    connection.execute = async (builder: any) => {
      const compiled: any = builder.toDB();
      const out = Array.isArray(compiled) ? compiled[0] : compiled;
      expressions.push(out?.expression ?? '');
      return await original(builder);
    };

    try {
      await Offer.where({ Id: 1 })
        .populate('Localisations', function (this: any) {
          this.populate('Network');
          this.populate('Metadata');
        })
        .first();
    } finally {
      connection.execute = original;
    }

    const metaQueries = expressions.filter((e) => e.includes('locationmeta'));
    expect(metaQueries).to.have.length(1);
  });
});
